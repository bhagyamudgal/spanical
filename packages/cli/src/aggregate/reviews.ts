import {
    and,
    count,
    eq,
    gte,
    inArray,
    isNotNull,
    isNull,
    lt,
    sql,
} from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { authorGithubLogins, authors, reviews, tickets } from "../cache/schema";
import { TICKET_KIND } from "../github/rows";
import type { ResolvedWindow } from "../window/types";
import { median, MS_PER_HOUR } from "./stats";
import { readLateSyncFloors } from "./sync-floors";
import type {
    DevReviewRollup,
    ExcludedReviews,
    LatencyBasis,
    ReviewAggregation,
    ReviewCoverage,
    ReviewLatency,
} from "./types";

const UNBOUNDED_START = 0;

// A review counts once it has been submitted — a pending review measures
// nothing — and only on someone else's pull request. Who wrote the pull request
// decides that, never the configured attribution mode: reviewing work you are
// merely credited for is still a review you gave someone.
const NOT_A_SELF_REVIEW = sql`(${reviews.reviewer} is null or ${tickets.author} is null or ${reviews.reviewer} <> ${tickets.author} collate nocase)`;
const COUNTED_REVIEW = and(isNotNull(reviews.submittedAt), NOT_A_SELF_REVIEW);

type ReviewOptions = {
    window: ResolvedWindow;
    repos: string[];
    timezone: string;
};

type Bounds = { start: number; end: number };

type ReviewerRow = {
    authorId: number | null;
    author: string | null;
    reviewer: string | null;
    isBot: boolean;
    prNodeId: string;
};

type LatencyRow = {
    authorId: number | null;
    isBot: boolean;
    requestedAt: number | null;
    openedAt: number;
    firstSubmittedAt: number;
};

type LatencySamples = Record<LatencyBasis, number[]>;

type ReviewerTally = {
    authorId: number | null;
    author: string | null;
    isBot: boolean;
    pullRequests: Set<string>;
};

function emptySamples(): LatencySamples {
    return { requested: [], created: [] };
}

function toLatency(samples: LatencySamples): ReviewLatency {
    const total = samples.requested.length + samples.created.length;
    return {
        latencyMedianHours: median([...samples.requested, ...samples.created]),
        requestedSamples: samples.requested.length,
        createdSamples: samples.created.length,
        fallbackShare: total === 0 ? null : samples.created.length / total,
    };
}

// Reviewers are stored as raw GitHub logins and resolved here; see docs/adr/0001.
function readReviewers(
    db: CacheDatabase,
    opts: ReviewOptions,
    bounds: Bounds
): ReviewerRow[] {
    return db
        .selectDistinct({
            authorId: authors.id,
            author: authors.canonicalName,
            reviewer: reviews.reviewer,
            isBot: reviews.reviewerIsBot,
            prNodeId: reviews.prNodeId,
        })
        .from(reviews)
        .innerJoin(tickets, eq(tickets.nodeId, reviews.prNodeId))
        .leftJoin(
            authorGithubLogins,
            eq(authorGithubLogins.login, reviews.reviewer)
        )
        .leftJoin(authors, eq(authors.id, authorGithubLogins.authorId))
        .where(
            and(
                inArray(tickets.repo, opts.repos),
                COUNTED_REVIEW,
                gte(reviews.submittedAt, bounds.start),
                lt(reviews.submittedAt, bounds.end)
            )
        )
        .all();
}

// One sample per request cycle: each review already carries the request that
// most closely precedes it, so grouping on it and taking the earliest review
// measures the answer to the first request and to every re-request after it.
function readLatencyRows(
    db: CacheDatabase,
    opts: ReviewOptions,
    bounds: Bounds
): LatencyRow[] {
    const firstSubmittedAt = sql<number>`min(${reviews.submittedAt})`;
    return (
        db
            .select({
                authorId: authors.id,
                isBot: reviews.reviewerIsBot,
                requestedAt: reviews.requestedAt,
                openedAt: tickets.createdAt,
                firstSubmittedAt,
            })
            .from(reviews)
            .innerJoin(tickets, eq(tickets.nodeId, reviews.prNodeId))
            .leftJoin(
                authorGithubLogins,
                eq(authorGithubLogins.login, reviews.reviewer)
            )
            .leftJoin(authors, eq(authors.id, authorGithubLogins.authorId))
            .where(and(inArray(tickets.repo, opts.repos), COUNTED_REVIEW))
            .groupBy(
                reviews.prNodeId,
                reviews.reviewer,
                reviews.requestedAt,
                reviews.reviewerIsBot,
                tickets.createdAt,
                authors.id
            )
            // Within a requested cycle the window filters the sample rather
            // than the rows it is drawn from, so a re-request answered inside
            // the window is a sample of it even when the same reviewer answered
            // an earlier request before it opened. Requestless reviews are one
            // lifetime cycle per reviewer and pull request — SQLite groups
            // their null requested_at together — so only a reviewer's very
            // first drive-by is ever a sample, and one before the window leaves
            // them with review load and no latency at all.
            .having(
                and(
                    gte(firstSubmittedAt, bounds.start),
                    lt(firstSubmittedAt, bounds.end)
                )
            )
            .all()
    );
}

// Coverage is measured over merged pull requests: a merged pull request's
// review history is final, while an open one can still pick up a review
// tomorrow, so counting it as uncovered would measure nothing.
function readCoverage(
    db: CacheDatabase,
    opts: ReviewOptions,
    bounds: Bounds
): ReviewCoverage {
    const row = db
        .select({
            merged: sql<number>`count(distinct ${tickets.nodeId})`,
            reviewed: sql<number>`count(distinct case when ${reviews.nodeId} is not null then ${tickets.nodeId} end)`,
        })
        .from(tickets)
        .leftJoin(
            reviews,
            and(eq(reviews.prNodeId, tickets.nodeId), COUNTED_REVIEW)
        )
        .where(
            and(
                inArray(tickets.repo, opts.repos),
                eq(tickets.kind, TICKET_KIND.pullRequest),
                gte(tickets.mergedAt, bounds.start),
                lt(tickets.mergedAt, bounds.end)
            )
        )
        .get();
    const pullRequestsMerged = row?.merged ?? 0;
    const pullRequestsReviewed = row?.reviewed ?? 0;
    return {
        pullRequestsMerged,
        pullRequestsReviewed,
        pullRequestsUnmerged: countUnmergedPullRequests(db, opts, bounds),
        share:
            pullRequestsMerged === 0
                ? null
                : pullRequestsReviewed / pullRequestsMerged,
    };
}

// Pull requests opened in the window that have not merged sit outside the
// coverage denominator entirely, so "1 of 1 (100%)" has to be readable beside
// however much open, unreviewed work the same window holds.
function countUnmergedPullRequests(
    db: CacheDatabase,
    opts: ReviewOptions,
    bounds: Bounds
): number {
    return (
        db
            .select({ value: count() })
            .from(tickets)
            .where(
                and(
                    inArray(tickets.repo, opts.repos),
                    eq(tickets.kind, TICKET_KIND.pullRequest),
                    isNull(tickets.mergedAt),
                    gte(tickets.createdAt, bounds.start),
                    lt(tickets.createdAt, bounds.end)
                )
            )
            .get()?.value ?? 0
    );
}

// What the window held that no metric could count. A pending review carries no
// submitted_at to place it in a window, so it is counted across the cached
// repositories rather than claimed for this window.
function readExcluded(
    db: CacheDatabase,
    opts: ReviewOptions,
    bounds: Bounds
): ExcludedReviews {
    const submittedInWindow = sql`${reviews.submittedAt} >= ${bounds.start} and ${reviews.submittedAt} < ${bounds.end}`;
    const row = db
        .select({
            selfReviews: sql<number>`coalesce(sum(case when ${submittedInWindow} and not ${NOT_A_SELF_REVIEW} then 1 else 0 end), 0)`,
            pendingReviews: sql<number>`coalesce(sum(case when ${reviews.submittedAt} is null then 1 else 0 end), 0)`,
        })
        .from(reviews)
        .innerJoin(tickets, eq(tickets.nodeId, reviews.prNodeId))
        .where(inArray(tickets.repo, opts.repos))
        .get();
    return {
        selfReviews: row?.selfReviews ?? 0,
        pendingReviews: row?.pendingReviews ?? 0,
    };
}

// Reviews given counts distinct pull requests, so three reviews on one pull
// request read as one. An unmapped login tallies under its own key rather than
// merging with every other unmapped reviewer, which would under-count the team.
// A deleted account is the exception: it carries no login, so every one of them
// tallies together — the cache cannot tell one deleted reviewer from another.
function tallyReviewers(rows: ReviewerRow[]): ReviewerTally[] {
    const byReviewer = new Map<string, ReviewerTally>();
    for (const row of rows) {
        const key =
            row.authorId === null
                ? `login:${row.reviewer ?? ""}`
                : `author:${row.authorId}`;
        const tally = byReviewer.get(key) ?? {
            authorId: row.authorId,
            author: row.author,
            isBot: row.isBot,
            pullRequests: new Set<string>(),
        };
        tally.pullRequests.add(row.prNodeId);
        byReviewer.set(key, tally);
    }
    return [...byReviewer.values()];
}

// Counts have to carry bots so the team total reconciles against the per-dev
// rows, but latency is read as responsiveness: an automated reviewer answering
// in seconds would drag the median away from every human row.
function collectLatency(rows: LatencyRow[]): {
    team: LatencySamples;
    byAuthor: Map<number, LatencySamples>;
    discarded: number;
} {
    const team = emptySamples();
    const byAuthor = new Map<number, LatencySamples>();
    let discarded = 0;
    for (const row of rows) {
        if (row.isBot) {
            continue;
        }
        const basis: LatencyBasis =
            row.requestedAt === null ? "created" : "requested";
        const startedAt = row.requestedAt ?? row.openedAt;
        // Only reachable on the created basis, where the pull request claims to
        // have opened after a review of it: a negative interval would render as
        // a confident number, so it is dropped and disclosed instead.
        if (row.firstSubmittedAt < startedAt) {
            discarded += 1;
            continue;
        }
        const hours = (row.firstSubmittedAt - startedAt) / MS_PER_HOUR;
        team[basis].push(hours);
        if (row.authorId !== null) {
            const samples = byAuthor.get(row.authorId) ?? emptySamples();
            samples[basis].push(hours);
            byAuthor.set(row.authorId, samples);
        }
    }
    return { team, byAuthor, discarded };
}

function buildDevRollups(
    tallies: ReviewerTally[],
    byAuthor: Map<number, LatencySamples>
): DevReviewRollup[] {
    const devs: DevReviewRollup[] = [];
    for (const tally of tallies) {
        if (tally.authorId === null || tally.author === null || tally.isBot) {
            continue;
        }
        devs.push({
            authorId: tally.authorId,
            author: tally.author,
            reviewsGiven: tally.pullRequests.size,
            ...toLatency(byAuthor.get(tally.authorId) ?? emptySamples()),
        });
    }
    return devs.sort(
        (left, right) =>
            left.author.localeCompare(right.author) ||
            left.authorId - right.authorId
    );
}

export function aggregateReviews(
    db: CacheDatabase,
    opts: ReviewOptions
): ReviewAggregation {
    const bounds: Bounds = {
        start: opts.window.start?.getTime() ?? UNBOUNDED_START,
        end: opts.window.end.getTime(),
    };
    const tallies = tallyReviewers(readReviewers(db, opts, bounds));
    const latency = collectLatency(readLatencyRows(db, opts, bounds));
    const devs = buildDevRollups(tallies, latency.byAuthor);

    const team = {
        reviewsGiven: tallies.reduce(
            (sum, tally) => sum + tally.pullRequests.size,
            0
        ),
        ...toLatency(latency.team),
        latencySamplesDiscarded: latency.discarded,
    };
    const devSamples = devs.reduce(
        (sum, dev) => sum + dev.requestedSamples + dev.createdSamples,
        0
    );

    return {
        coverage: readCoverage(db, opts, bounds),
        excluded: readExcluded(db, opts, bounds),
        lateSyncFloors: readLateSyncFloors(db, {
            repos: opts.repos,
            timezone: opts.timezone,
            windowStart: opts.window.start,
        }),
        devs,
        team,
        unattributed: {
            reviewsGiven:
                team.reviewsGiven -
                devs.reduce((sum, dev) => sum + dev.reviewsGiven, 0),
            latencySamples:
                team.requestedSamples + team.createdSamples - devSamples,
        },
    };
}
