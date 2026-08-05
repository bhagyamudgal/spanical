import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { authorGithubLogins, authors, tickets } from "../cache/schema";
import { TICKET_KIND } from "../github/rows";
import type { ResolvedWindow } from "../window/types";
import { creditedColumns } from "./attribution";
import { matchReverts, type RevertTally } from "./reverts";
import { median, MS_PER_HOUR } from "./stats";
import { readLateSyncFloors } from "./sync-floors";
import type {
    DevTicketRollup,
    PullRequestSizeBucket,
    TicketAggregation,
    TicketAttribution,
    TicketCounts,
    TicketCoverage,
    TicketFlow,
} from "./types";

const UNBOUNDED_START = 0;

const LARGEST_BUCKET = { label: "1000+", limit: Number.POSITIVE_INFINITY };
const SIZE_BUCKETS = [
    { label: "0-9", limit: 9 },
    { label: "10-99", limit: 99 },
    { label: "100-499", limit: 499 },
    { label: "500-999", limit: 999 },
    LARGEST_BUCKET,
];

type TicketOptions = {
    window: ResolvedWindow;
    repos: string[];
    attribution: TicketAttribution;
    timezone: string;
    includeIssues: boolean;
};

type Bounds = { start: number; end: number };
type FlowSamples = { cycleTimeHours: number[]; sizes: number[] };
type FlowCollection = {
    team: FlowSamples;
    byAuthor: Map<number, FlowSamples>;
    cycleTimesDiscarded: number;
};
type CountRow = {
    authorId: number | null;
    author: string | null;
    isBot: boolean;
    opened: number;
    merged: number;
    closed: number;
    reopened: number;
};

function emptyCounts(): TicketCounts {
    return { opened: 0, merged: 0, closed: 0, reopened: 0, reverted: 0 };
}

function emptySamples(): FlowSamples {
    return { cycleTimeHours: [], sizes: [] };
}

function toFlow(samples: FlowSamples): TicketFlow {
    return {
        cycleTimeMedianHours: median(samples.cycleTimeHours),
        pullRequestSizeMedian: median(samples.sizes),
    };
}

function isCredited(row: { authorId: number | null; isBot: boolean }): boolean {
    return row.authorId !== null && !row.isBot;
}

// A merged pull request is never also counted as closed, so the three columns
// partition the window's tickets instead of double-counting every merge.
function countExpressions(bounds: Bounds) {
    const { start, end } = bounds;
    const openedInWindow = sql`${tickets.createdAt} >= ${start} and ${tickets.createdAt} < ${end}`;
    return {
        opened: sql<number>`sum(case when ${openedInWindow} then 1 else 0 end)`,
        merged: sql<number>`sum(case when ${tickets.mergedAt} >= ${start} and ${tickets.mergedAt} < ${end} then 1 else 0 end)`,
        closed: sql<number>`sum(case when ${tickets.mergedAt} is null and ${tickets.closedAt} >= ${start} and ${tickets.closedAt} < ${end} then 1 else 0 end)`,
        // reopened_count is a lifetime total with no per-event timestamp, so it
        // rides along with the window the ticket was opened in.
        reopened: sql<number>`sum(case when ${openedInWindow} then ${tickets.reopenedCount} else 0 end)`,
    };
}

function readCounts(
    db: CacheDatabase,
    opts: TicketOptions,
    bounds: Bounds
): CountRow[] {
    const credited = creditedColumns(opts.attribution);
    return db
        .select({
            authorId: authors.id,
            author: authors.canonicalName,
            isBot: credited.isBot,
            ...countExpressions(bounds),
        })
        .from(tickets)
        .leftJoin(
            authorGithubLogins,
            eq(authorGithubLogins.login, credited.login)
        )
        .leftJoin(authors, eq(authors.id, authorGithubLogins.authorId))
        .where(inArray(tickets.repo, opts.repos))
        .groupBy(authors.id, authors.canonicalName, credited.isBot)
        .all();
}

function readMergedPullRequests(
    db: CacheDatabase,
    opts: TicketOptions,
    bounds: Bounds
) {
    const credited = creditedColumns(opts.attribution);
    return db
        .select({
            authorId: authors.id,
            isBot: credited.isBot,
            cycleTimeMs: sql<number>`${tickets.mergedAt} - ${tickets.createdAt}`,
            // GitHub's additions and deletions serve pull-request flow only;
            // they never reach the churn rollups, which stay authoritative on
            // git numstat (spec §5). The sync schema requires both on a pull
            // request, so the coalesce only guards rows this filter excludes.
            size: sql<number>`coalesce(${tickets.additions}, 0) + coalesce(${tickets.deletions}, 0)`,
        })
        .from(tickets)
        .leftJoin(
            authorGithubLogins,
            eq(authorGithubLogins.login, credited.login)
        )
        .leftJoin(authors, eq(authors.id, authorGithubLogins.authorId))
        .where(
            and(
                inArray(tickets.repo, opts.repos),
                eq(tickets.kind, TICKET_KIND.pullRequest),
                gte(tickets.mergedAt, bounds.start),
                lt(tickets.mergedAt, bounds.end)
            )
        )
        .all();
}

// Counts have to carry bots so team totals reconcile against the per-dev rows,
// but cycle time and size are read as flow health: one bot merging one-line
// bumps in seconds would drag the team medians away from every human row.
function collectFlow(
    db: CacheDatabase,
    opts: TicketOptions,
    bounds: Bounds
): FlowCollection {
    const team = emptySamples();
    const byAuthor = new Map<number, FlowSamples>();
    let cycleTimesDiscarded = 0;

    for (const row of readMergedPullRequests(db, opts, bounds)) {
        const authorId = isCredited(row) ? row.authorId : null;
        const credited =
            authorId === null
                ? null
                : (byAuthor.get(authorId) ?? emptySamples());
        if (authorId !== null && credited !== null) {
            byAuthor.set(authorId, credited);
        }
        const humanTeamSamples = row.isBot ? null : team;

        if (row.cycleTimeMs < 0) {
            cycleTimesDiscarded += 1;
        } else {
            const hours = row.cycleTimeMs / MS_PER_HOUR;
            humanTeamSamples?.cycleTimeHours.push(hours);
            credited?.cycleTimeHours.push(hours);
        }
        humanTeamSamples?.sizes.push(row.size);
        credited?.sizes.push(row.size);
    }
    return { team, byAuthor, cycleTimesDiscarded };
}

function bucketSizes(sizes: number[]): PullRequestSizeBucket[] {
    const counts = new Map<string, number>();
    for (const size of sizes) {
        const bucket =
            SIZE_BUCKETS.find((entry) => size <= entry.limit) ?? LARGEST_BUCKET;
        counts.set(bucket.label, (counts.get(bucket.label) ?? 0) + 1);
    }
    return SIZE_BUCKETS.map((bucket) => {
        const pullRequests = counts.get(bucket.label) ?? 0;
        return {
            label: bucket.label,
            pullRequests,
            share: sizes.length === 0 ? 0 : pullRequests / sizes.length,
        };
    });
}

function addCounts(target: TicketCounts, row: CountRow): void {
    target.opened += row.opened;
    target.merged += row.merged;
    target.closed += row.closed;
    target.reopened += row.reopened;
}

function readCoverage(db: CacheDatabase, opts: TicketOptions): TicketCoverage {
    return {
        includeIssues: opts.includeIssues,
        lateSyncFloors: readLateSyncFloors(db, {
            repos: opts.repos,
            timezone: opts.timezone,
            windowStart: opts.window.start,
        }),
    };
}

export function hasTicketActivity(counts: TicketCounts): boolean {
    return (
        counts.opened +
            counts.merged +
            counts.closed +
            counts.reopened +
            counts.reverted >
        0
    );
}

function buildDevRollups(
    rows: CountRow[],
    reverts: RevertTally,
    flowByAuthor: Map<number, FlowSamples>
): DevTicketRollup[] {
    const byAuthor = new Map<number, DevTicketRollup>();

    function rollupFor(authorId: number, author: string): DevTicketRollup {
        const existing = byAuthor.get(authorId);
        if (existing !== undefined) {
            return existing;
        }
        const created: DevTicketRollup = {
            authorId,
            author,
            ...emptyCounts(),
            ...toFlow(flowByAuthor.get(authorId) ?? emptySamples()),
        };
        byAuthor.set(authorId, created);
        return created;
    }

    for (const row of rows) {
        if (row.authorId === null || row.author === null || !isCredited(row)) {
            continue;
        }
        addCounts(rollupFor(row.authorId, row.author), row);
    }
    for (const [authorId, credit] of reverts.byAuthor) {
        rollupFor(authorId, credit.author).reverted += credit.reverted;
    }

    // The counts query groups every cached ticket, so an author whose whole
    // history sits outside the window arrives as a group of zeroes.
    return [...byAuthor.values()]
        .filter(hasTicketActivity)
        .sort(
            (left, right) =>
                left.author.localeCompare(right.author) ||
                left.authorId - right.authorId
        );
}

export function aggregateTickets(
    db: CacheDatabase,
    opts: TicketOptions
): TicketAggregation {
    const bounds: Bounds = {
        start: opts.window.start?.getTime() ?? UNBOUNDED_START,
        end: opts.window.end.getTime(),
    };
    const rows = readCounts(db, opts, bounds);
    const reverts = matchReverts(db, {
        repos: opts.repos,
        attribution: opts.attribution,
        ...bounds,
    });
    const flow = collectFlow(db, opts, bounds);

    const team = emptyCounts();
    const unattributed = emptyCounts();
    for (const row of rows) {
        addCounts(team, row);
        if (!isCredited(row) || row.author === null) {
            addCounts(unattributed, row);
        }
    }
    team.reverted = reverts.matched + reverts.unmatched;

    const devs = buildDevRollups(rows, reverts, flow.byAuthor);
    unattributed.reverted =
        team.reverted - devs.reduce((sum, dev) => sum + dev.reverted, 0);

    return {
        attribution: opts.attribution,
        coverage: readCoverage(db, opts),
        devs,
        team: {
            ...team,
            ...toFlow(flow.team),
            unmatchedReverts: reverts.unmatched,
            cycleTimesDiscarded: flow.cycleTimesDiscarded,
        },
        pullRequestSizes: bucketSizes(flow.team.sizes),
        unattributed,
    };
}
