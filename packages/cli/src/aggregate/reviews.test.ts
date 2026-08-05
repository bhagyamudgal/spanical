import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache/open";
import { githubSyncs, reviews, tickets } from "../cache/schema";
import { upsertAuthor, upsertGithubLogin } from "../extract/authors";
import { TICKET_KIND, type ReviewRow, type TicketRow } from "../github/rows";
import { renderReviewsReport, type RenderFormat } from "../render";
import type { ResolvedWindow } from "../window/types";
import { aggregateReviews } from "./reviews";
import type { DevReviewRollup, ReviewAggregation } from "./types";

type Handle = ReturnType<typeof openCache>;
type Actor = { login: string; isBot?: boolean };

const REPO = "web-app";
const WINDOW_START = new Date("2026-07-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-01T00:00:00Z");
const WINDOW: ResolvedWindow = {
    start: WINDOW_START,
    end: WINDOW_END,
    granularity: "month",
    periods: [{ label: "2026-07", start: WINDOW_START, end: WINDOW_END }],
    label: "2026-07",
};

// The window a truncated cache misleads most: "all history up to the end".
const UNBOUNDED_WINDOW: ResolvedWindow = {
    start: null,
    end: WINDOW_END,
    granularity: "month",
    periods: [{ label: "2026-07", start: WINDOW_START, end: WINDOW_END }],
    label: "history -> 2026-07",
};

const DEV_ONE = { login: "dev-one-gh" };
const DEV_TWO = { login: "dev-two-gh" };
const DEV_THREE = { login: "dev-three-gh" };
const BOT = { login: "renovate", isBot: true };

const APPROVED = "APPROVED";

function withCache<T>(fn: (handle: Handle) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "spanical-reviews-"));
    const handle = openCache({ cwd: dir });
    try {
        return fn(handle);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

function seedAuthors(handle: Handle): void {
    for (const [name, actor] of [
        ["dev-one", DEV_ONE],
        ["dev-two", DEV_TWO],
        ["dev-three", DEV_THREE],
    ] as const) {
        upsertGithubLogin(
            handle.db,
            actor.login,
            upsertAuthor(handle.db, name)
        );
    }
}

function pullRequest(options: {
    id: string;
    number: number;
    author: Actor;
    createdAt: string;
    mergedAt?: string;
    repo?: string;
}): TicketRow {
    const mergedAt =
        options.mergedAt === undefined ? null : Date.parse(options.mergedAt);
    return {
        nodeId: options.id,
        repo: options.repo ?? REPO,
        kind: TICKET_KIND.pullRequest,
        number: options.number,
        title: `feat: ${options.id}`,
        author: options.author.login,
        authorIsBot: options.author.isBot ?? false,
        assignee: null,
        assigneeIsBot: false,
        closedBy: null,
        closedByIsBot: false,
        createdAt: Date.parse(options.createdAt),
        closedAt: mergedAt,
        mergedAt,
        updatedAt: Date.parse(options.createdAt),
        state: mergedAt === null ? "OPEN" : "MERGED",
        reopenedCount: 0,
        additions: null,
        deletions: null,
    };
}

function review(options: {
    id: string;
    pullRequest: string;
    reviewer: Actor | null;
    submittedAt?: string;
    requestedAt?: string;
}): ReviewRow {
    return {
        nodeId: options.id,
        prNodeId: options.pullRequest,
        reviewer: options.reviewer?.login ?? null,
        reviewerIsBot: options.reviewer?.isBot ?? false,
        submittedAt:
            options.submittedAt === undefined
                ? null
                : Date.parse(options.submittedAt),
        requestedAt:
            options.requestedAt === undefined
                ? null
                : Date.parse(options.requestedAt),
        state: options.submittedAt === undefined ? "PENDING" : APPROVED,
    };
}

function seed(
    handle: Handle,
    pullRequests: TicketRow[],
    reviewRows: ReviewRow[] = []
): void {
    handle.db.insert(tickets).values(pullRequests).run();
    if (reviewRows.length > 0) {
        handle.db.insert(reviews).values(reviewRows).run();
    }
}

function seedSyncFloor(handle: Handle, since: string): void {
    handle.db
        .insert(githubSyncs)
        .values({
            repo: REPO,
            slug: "acme/web",
            since,
            syncedThrough: 0,
            issuesSyncedThrough: 0,
            syncedAt: 0,
        })
        .run();
}

function aggregate(
    handle: Handle,
    window: ResolvedWindow = WINDOW
): ReviewAggregation {
    return aggregateReviews(handle.db, {
        window,
        repos: [REPO],
        timezone: "UTC",
    });
}

function devNamed(
    devs: DevReviewRollup[],
    author: string
): DevReviewRollup | undefined {
    return devs.find((dev) => dev.author === author);
}

function render(result: ReviewAggregation, format: RenderFormat): string {
    return renderReviewsReport(format, result, {
        window: WINDOW.label,
        repos: [REPO],
    });
}

const TABLE_COLUMN_SEPARATOR = "│";

// Column position is the whole claim a rendered row makes, so the cells are
// read apart rather than searched for as substrings.
function tableCells(table: string, label: string): string[] {
    const line =
        Bun.stripANSI(table)
            .split("\n")
            .find((row) => row.includes(label)) ?? "";
    return line
        .split(TABLE_COLUMN_SEPARATOR)
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
}

// Four merged pull requests, three of them reviewed: dev-two answers a review
// request after 4h, dev-three drives by with no request 10h after the pull
// request opened, a bot answers in half an hour, and one merge is never seen.
const FIXTURE_PULL_REQUESTS: TicketRow[] = [
    pullRequest({
        id: "pr-1",
        number: 1,
        author: DEV_ONE,
        createdAt: "2026-07-01T00:00:00Z",
        mergedAt: "2026-07-03T00:00:00Z",
    }),
    pullRequest({
        id: "pr-2",
        number: 2,
        author: DEV_ONE,
        createdAt: "2026-07-02T00:00:00Z",
        mergedAt: "2026-07-05T00:00:00Z",
    }),
    pullRequest({
        id: "pr-3",
        number: 3,
        author: DEV_TWO,
        createdAt: "2026-07-03T00:00:00Z",
        mergedAt: "2026-07-04T00:00:00Z",
    }),
    pullRequest({
        id: "pr-4",
        number: 4,
        author: DEV_THREE,
        createdAt: "2026-07-04T00:00:00Z",
        mergedAt: "2026-07-06T00:00:00Z",
    }),
];

const FIXTURE_REVIEWS: ReviewRow[] = [
    review({
        id: "review-1",
        pullRequest: "pr-1",
        reviewer: DEV_TWO,
        requestedAt: "2026-07-01T00:00:00Z",
        submittedAt: "2026-07-01T04:00:00Z",
    }),
    review({
        id: "review-2",
        pullRequest: "pr-2",
        reviewer: DEV_THREE,
        submittedAt: "2026-07-02T10:00:00Z",
    }),
    review({
        id: "review-4",
        pullRequest: "pr-4",
        reviewer: BOT,
        submittedAt: "2026-07-04T00:30:00Z",
    }),
];

test("a review answering a request measures latency from the request", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);

        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        expect(devTwo?.reviewsGiven).toBe(1);
        expect(devTwo?.latencyMedianHours).toBe(4);
        expect(devTwo?.requestedSamples).toBe(1);
        expect(devTwo?.createdSamples).toBe(0);
        expect(devTwo?.fallbackShare).toBe(0);
    });
});

test("a review with no request falls back to the pull request opening", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);

        const devThree = devNamed(aggregate(handle).devs, "dev-three");
        expect(devThree?.latencyMedianHours).toBe(10);
        expect(devThree?.requestedSamples).toBe(0);
        expect(devThree?.createdSamples).toBe(1);
        expect(devThree?.fallbackShare).toBe(1);
    });
});

test("the reported fallback share matches the mix of cached reviews", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const { team } = aggregate(handle);

        expect(team.requestedSamples).toBe(1);
        expect(team.createdSamples).toBe(1);
        expect(team.fallbackShare).toBe(0.5);
        expect(team.latencyMedianHours).toBe(7);
    });
});

test("the fallback share is absent rather than zero when nothing was sampled", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS);
        const { team } = aggregate(handle);

        expect(team.latencyMedianHours).toBeNull();
        expect(team.fallbackShare).toBeNull();
    });
});

test("a re-requested review is measured from the re-request, not the first ask", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-10T00:00:00Z",
                    mergedAt: "2026-07-12T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-10T00:00:00Z",
                    submittedAt: "2026-07-10T02:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-11T00:00:00Z",
                    submittedAt: "2026-07-11T06:00:00Z",
                }),
            ]
        );

        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        // 2h for the first ask and 6h for the re-request: measuring the second
        // review from the first request would report 30h.
        expect(devTwo?.requestedSamples).toBe(2);
        expect(devTwo?.latencyMedianHours).toBe(4);
        expect(devTwo?.reviewsGiven).toBe(1);
    });
});

test("several reviews inside one request cycle count as one sample", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-10T00:00:00Z",
                    mergedAt: "2026-07-12T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-10T00:00:00Z",
                    submittedAt: "2026-07-10T02:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-10T00:00:00Z",
                    submittedAt: "2026-07-10T09:00:00Z",
                }),
            ]
        );

        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        expect(devTwo?.reviewsGiven).toBe(1);
        expect(devTwo?.requestedSamples).toBe(1);
        expect(devTwo?.latencyMedianHours).toBe(2);
    });
});

test("a reviewer on two pull requests is credited with two reviews given", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-10T00:00:00Z",
                    mergedAt: "2026-07-12T00:00:00Z",
                }),
                pullRequest({
                    id: "pr-2",
                    number: 2,
                    author: DEV_ONE,
                    createdAt: "2026-07-11T00:00:00Z",
                    mergedAt: "2026-07-13T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-10T00:00:00Z",
                    submittedAt: "2026-07-10T02:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-2",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-11T00:00:00Z",
                    submittedAt: "2026-07-11T08:00:00Z",
                }),
            ]
        );

        // Distinct pull requests are what reviews given counts, so the metric
        // only means anything once one reviewer has answered more than one.
        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        expect(devTwo?.reviewsGiven).toBe(2);
        expect(devTwo?.requestedSamples).toBe(2);
        expect(devTwo?.latencyMedianHours).toBe(5);
    });
});

test("two GitHub logins mapped to one author fold into a single row", () => {
    withCache((handle) => {
        seedAuthors(handle);
        upsertGithubLogin(
            handle.db,
            "dev-two-alt-gh",
            upsertAuthor(handle.db, "dev-two")
        );
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-10T00:00:00Z",
                    mergedAt: "2026-07-12T00:00:00Z",
                }),
                pullRequest({
                    id: "pr-2",
                    number: 2,
                    author: DEV_ONE,
                    createdAt: "2026-07-11T00:00:00Z",
                    mergedAt: "2026-07-13T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-10T02:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-2",
                    reviewer: { login: "dev-two-alt-gh" },
                    submittedAt: "2026-07-11T02:00:00Z",
                }),
            ]
        );
        const result = aggregate(handle);

        // Tallying by author rather than by login is the whole reason the
        // identity mapping is resolved at query time; a second login for the
        // same person has to read as more review load, not another reviewer.
        expect(result.devs.map((dev) => dev.author)).toEqual(["dev-two"]);
        expect(result.devs[0]?.reviewsGiven).toBe(2);
        expect(result.unattributed.reviewsGiven).toBe(0);
    });
});

test("a self-review counts nowhere, not for the reviewer and not for coverage", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_ONE,
                    submittedAt: "2026-07-01T06:00:00Z",
                }),
            ]
        );

        const result = aggregate(handle);
        expect(result.devs).toEqual([]);
        expect(result.team.reviewsGiven).toBe(0);
        expect(result.coverage).toEqual({
            pullRequestsMerged: 1,
            pullRequestsReviewed: 0,
            pullRequestsUnmerged: 0,
            share: 0,
        });
    });
});

test("a self-review under a different login casing is still a self-review", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: { login: "Dev-One-GH" },
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_ONE,
                    submittedAt: "2026-07-01T06:00:00Z",
                }),
            ]
        );

        expect(aggregate(handle).team.reviewsGiven).toBe(0);
    });
});

test("a pending review is not counted until it is submitted", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-01T00:00:00Z",
                }),
            ]
        );

        const result = aggregate(handle);
        expect(result.team.reviewsGiven).toBe(0);
        expect(result.team.latencyMedianHours).toBeNull();
        expect(result.coverage.pullRequestsReviewed).toBe(0);
    });
});

test("an unmapped bot's review counts toward the team and coverage, not per dev", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const result = aggregate(handle);

        expect(result.devs.map((dev) => dev.author)).toEqual([
            "dev-three",
            "dev-two",
        ]);
        expect(result.team.reviewsGiven).toBe(3);
        expect(result.unattributed.reviewsGiven).toBe(1);
        expect(result.coverage.pullRequestsReviewed).toBe(3);
    });
});

test("a bot mapped to an author is still kept out of the per-dev rows", () => {
    withCache((handle) => {
        seedAuthors(handle);
        // Mapping the bot login is what makes the bot rule load-bearing: an
        // unmapped bot is kept out of the per-dev rows by having no author at
        // all, so only a mapped one can prove the rule is what excludes it.
        upsertGithubLogin(
            handle.db,
            BOT.login,
            upsertAuthor(handle.db, "renovate")
        );
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const result = aggregate(handle);

        expect(result.devs.map((dev) => dev.author)).toEqual([
            "dev-three",
            "dev-two",
        ]);
        // The other half of the asymmetry: the same review the per-dev rows
        // refuse still covers the pull request it was left on.
        expect(result.team.reviewsGiven).toBe(3);
        expect(result.unattributed.reviewsGiven).toBe(1);
        expect(result.coverage.pullRequestsReviewed).toBe(3);
        expect(result.coverage.share).toBe(0.75);
    });
});

test("a bot answering in minutes never moves the team latency median", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-01T00:00:00Z",
                    submittedAt: "2026-07-01T10:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-1",
                    reviewer: BOT,
                    requestedAt: "2026-07-01T00:00:00Z",
                    submittedAt: "2026-07-01T00:01:00Z",
                }),
            ]
        );

        const { team } = aggregate(handle);
        expect(team.reviewsGiven).toBe(2);
        expect(team.latencyMedianHours).toBe(10);
        expect(team.requestedSamples).toBe(1);
    });
});

test("review coverage reports the merged pull requests that carry a review", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);

        expect(aggregate(handle).coverage).toEqual({
            pullRequestsMerged: 4,
            pullRequestsReviewed: 3,
            pullRequestsUnmerged: 0,
            share: 0.75,
        });
    });
});

test("an unmerged pull request is outside review coverage entirely", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-open",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-open",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-01T05:00:00Z",
                }),
            ]
        );

        const result = aggregate(handle);
        expect(result.coverage.pullRequestsMerged).toBe(0);
        expect(result.coverage.share).toBeNull();
        // The review itself still counts as review load.
        expect(result.team.reviewsGiven).toBe(1);
    });
});

test("a review submitted outside the window is left out of the load", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-06-01T00:00:00Z",
                    mergedAt: "2026-06-03T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-06-01T00:00:00Z",
                    submittedAt: "2026-06-01T04:00:00Z",
                }),
            ]
        );

        const result = aggregate(handle);
        expect(result.team.reviewsGiven).toBe(0);
        expect(result.team.latencyMedianHours).toBeNull();
        expect(result.devs).toEqual([]);
    });
});

test("a re-request answered inside the window is sampled from that request", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-06-20T00:00:00Z",
                    mergedAt: "2026-07-05T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-06-20T00:00:00Z",
                    submittedAt: "2026-06-21T00:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-02T00:00:00Z",
                    submittedAt: "2026-07-02T05:00:00Z",
                }),
            ]
        );

        // The window filters the sample, not the rows it is drawn from: the
        // answer to the first ask fell outside it, the answer to the
        // re-request did not, and only the second is this window's latency.
        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        expect(devTwo?.requestedSamples).toBe(1);
        expect(devTwo?.latencyMedianHours).toBe(5);
        expect(devTwo?.reviewsGiven).toBe(1);
    });
});

test("a drive-by before the window leaves review load and no latency at all", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-06-20T00:00:00Z",
                    mergedAt: "2026-07-05T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-06-25T00:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-02T00:00:00Z",
                }),
            ]
        );

        // Requestless reviews are one lifetime cycle per reviewer and pull
        // request, and this one was answered before the window opened, so the
        // in-window review is load the latency medians cannot speak for.
        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        expect(devTwo?.reviewsGiven).toBe(1);
        expect(devTwo?.createdSamples).toBe(0);
        expect(devTwo?.latencyMedianHours).toBeNull();
    });
});

test("a review of another repo's pull request never reaches the totals", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-api",
                    number: 1,
                    repo: "api",
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-api",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-01T04:00:00Z",
                }),
            ]
        );

        const result = aggregate(handle);
        expect(result.team.reviewsGiven).toBe(0);
        expect(result.coverage.pullRequestsMerged).toBe(0);
    });
});

test("a reviewer with no author mapping is named in the rendered report", () => {
    withCache((handle) => {
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const result = aggregate(handle);

        expect(result.devs).toEqual([]);
        expect(result.team.reviewsGiven).toBe(3);
        expect(result.unattributed.reviewsGiven).toBe(3);
        expect(result.unattributed.latencySamples).toBe(2);

        const markdown = render(result, "md");
        expect(markdown).toContain(
            "every review in this window came from a bot"
        );
        expect(markdown).toContain("no per-dev row does");
        expect(markdown).toContain("3 review(s) given and 2 latency sample(s)");
    });
});

test("the per-dev rows and the unattributed gap add up to the team count", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const { devs, team, unattributed } = aggregate(handle);

        expect(devs.map((dev) => dev.reviewsGiven)).toEqual([1, 1]);
        expect(team.reviewsGiven).toBe(3);
        // The bot's review is the whole gap, and it was never sampled for
        // latency, so the samples reconcile with nothing left over.
        expect(unattributed.reviewsGiven).toBe(1);
        expect(unattributed.latencySamples).toBe(0);
        expect(team.requestedSamples + team.createdSamples).toBe(2);
    });
});

test("a sync floor later than the window start is disclosed", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        seedSyncFloor(handle, "2026-07-04");
        const result = aggregate(handle);

        expect(result.lateSyncFloors).toEqual([
            { repo: REPO, since: "2026-07-04" },
        ]);
        expect(render(result, "md")).toContain("synced from a later date");
    });
});

test("an unbounded window discloses the sync floor rather than staying silent", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        seedSyncFloor(handle, "2026-07-01");
        const result = aggregate(handle, UNBOUNDED_WINDOW);

        // The window whose label promises all history is the one a truncated
        // cache misleads most, so it cannot be the one window that says nothing.
        expect(result.lateSyncFloors).toEqual([
            { repo: REPO, since: "2026-07-01" },
        ]);
        expect(render(result, "md")).toContain("synced from a later date");
    });
});

test("an empty window still discloses that the cache starts after it", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedSyncFloor(handle, "2026-07-20");
        const result = aggregate(handle);

        const markdown = render(result, "md");
        expect(markdown).toContain("No reviews cached for 2026-07");
        expect(markdown).toContain("synced from a later date");
        expect(markdown).toContain("web-app (2026-07-20)");
    });
});

test("a sync floor at or before the window start is not reported as a gap", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        seedSyncFloor(handle, "2026-06-01");

        expect(aggregate(handle).lateSyncFloors).toEqual([]);
        expect(render(aggregate(handle), "md")).not.toContain(
            "synced from a later date"
        );
    });
});

test("markdown carries the read flags, the basis mix and the coverage line", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const markdown = render(aggregate(handle), "md");

        expect(markdown).toContain("## Review load");
        expect(markdown).toContain("| Author | Reviews given (signal) |");
        expect(markdown).toContain("Latency basis (context)");
        expect(markdown).toContain(
            "| dev-two | 1 | 4 | 1 requested, 0 created"
        );
        expect(markdown).toContain(
            "Team: 3 reviews given · review latency 7h median · latency basis 1 requested, 1 created"
        );
        expect(markdown).toContain(
            "Review coverage: 3 of 4 merged pull request(s) carry a review (75%)"
        );
    });
});

test("the terminal table prints each dev's numbers under its own column", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const table = render(aggregate(handle), "table");

        expect(tableCells(table, "Author")).toEqual([
            "Author",
            "Reviews given (signal)",
            "Review latency h (signal)",
            "Latency basis (context)",
        ]);
        // Header labels alone would pass while every number sat one column off.
        expect(tableCells(table, "dev-two")).toEqual([
            "dev-two",
            "1",
            "4",
            "1 requested, 0 created",
        ]);
        expect(tableCells(table, "dev-three")).toEqual([
            "dev-three",
            "1",
            "10",
            "0 requested, 1 created",
        ]);
        expect(table).toContain("Review coverage: 3 of 4");
    });
});

test("json returns the raw aggregation rather than a rendered grid", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, FIXTURE_REVIEWS);
        const result = aggregate(handle);

        // Structured, not prose: a consumer has to be able to test the basis mix
        // and the cache coverage without parsing a note, per row as well as for
        // the team, since the notes that carry the caveats are absent here.
        const parsed: unknown = JSON.parse(render(result, "json"));
        expect(parsed).toHaveProperty(["team", "reviewsGiven"], 3);
        expect(parsed).toHaveProperty(["team", "latencyMedianHours"], 7);
        expect(parsed).toHaveProperty(["team", "requestedSamples"], 1);
        expect(parsed).toHaveProperty(["team", "createdSamples"], 1);
        expect(parsed).toHaveProperty(["team", "fallbackShare"], 0.5);
        expect(parsed).toHaveProperty(["devs", 0, "author"], "dev-three");
        expect(parsed).toHaveProperty(["devs", 0, "createdSamples"], 1);
        expect(parsed).toHaveProperty(["devs", 0, "fallbackShare"], 1);
        expect(parsed).toHaveProperty(["coverage", "share"], 0.75);
        expect(parsed).toHaveProperty(["lateSyncFloors"], []);
    });
});

test("an empty review window says so instead of rendering an empty grid", () => {
    withCache((handle) => {
        seedAuthors(handle);
        const result = aggregate(handle);

        for (const format of ["table", "md"] as const) {
            const output = render(result, format);
            expect(output).toContain("No reviews cached for 2026-07");
            expect(output).toContain(REPO);
            expect(output).not.toContain("Reviews given");
        }
        // json is the one format with no prose to fall back on, so the empty
        // window has to reach it as a payload rather than as the message.
        const parsed: unknown = JSON.parse(render(result, "json"));
        expect(parsed).toHaveProperty(["devs"], []);
        expect(parsed).toHaveProperty(["team", "reviewsGiven"], 0);
        expect(parsed).toHaveProperty(["coverage", "pullRequestsMerged"], 0);
    });
});

test("open pull requests are named beside a coverage figure that excludes them", () => {
    withCache((handle) => {
        seedAuthors(handle);
        const open = Array.from({ length: 9 }, (_unused, index) =>
            pullRequest({
                id: `pr-open-${index}`,
                number: index + 2,
                author: DEV_ONE,
                createdAt: "2026-07-10T00:00:00Z",
            })
        );
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
                ...open,
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-01T05:00:00Z",
                }),
            ]
        );
        const result = aggregate(handle);

        // "1 of 1 ... 100%" is the shape a short window most often produces;
        // on its own it hides nine open, unreviewed pull requests.
        expect(result.coverage.pullRequestsUnmerged).toBe(9);
        expect(render(result, "md")).toContain(
            "9 further pull request(s) opened in this window have not merged"
        );
    });
});

test("a window whose only review is a self-review says which rule excluded it", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_ONE,
                    submittedAt: "2026-07-01T06:00:00Z",
                }),
            ]
        );
        const result = aggregate(handle);

        expect(result.excluded).toEqual({
            selfReviews: 1,
            pendingReviews: 0,
        });
        const markdown = render(result, "md");
        // "no review was submitted" would send a reader to check their token
        // when the sync in fact found one and the rules discarded it.
        expect(markdown).toContain("1 self-review(s) submitted in this window");
        expect(markdown).not.toContain("no review was submitted");
    });
});

test("a pending review is named rather than reported as an empty window", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    requestedAt: "2026-07-01T00:00:00Z",
                }),
            ]
        );
        const result = aggregate(handle);

        expect(result.excluded.pendingReviews).toBe(1);
        expect(render(result, "md")).toContain(
            "1 cached review(s) still pending"
        );
    });
});

test("a populated report still names the reviews it excluded by definition", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, FIXTURE_PULL_REQUESTS, [
            ...FIXTURE_REVIEWS,
            review({
                id: "review-self",
                pullRequest: "pr-1",
                reviewer: DEV_ONE,
                submittedAt: "2026-07-01T08:00:00Z",
            }),
            review({
                id: "review-pending",
                pullRequest: "pr-2",
                reviewer: DEV_ONE,
                requestedAt: "2026-07-02T00:00:00Z",
            }),
        ]);
        const result = aggregate(handle);

        // dev-one reviewed twice and appears in no row on the page; without the
        // note the report reads as though they never opened a pull request.
        expect(result.devs.map((dev) => dev.author)).not.toContain("dev-one");
        expect(render(result, "md")).toContain(
            "1 self-review(s) submitted in this window and 1 cached review(s) still pending count nowhere by definition"
        );
    });
});

test("two requestless reviews on one pull request stay one latency sample", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-10T00:00:00Z",
                    mergedAt: "2026-07-12T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-10T03:00:00Z",
                }),
                review({
                    id: "review-2",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-11T00:00:00Z",
                }),
            ]
        );

        // Pins the SQL grouping: null requested_at values group together, so a
        // reviewer with no request has one lifetime cycle per pull request.
        // Keying them apart would report the second drive-by as 24h of latency.
        const devTwo = devNamed(aggregate(handle).devs, "dev-two");
        expect(devTwo?.createdSamples).toBe(1);
        expect(devTwo?.latencyMedianHours).toBe(3);
    });
});

test("a review submitted before its pull request opened is dropped and disclosed", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-10T00:00:00Z",
                    mergedAt: "2026-07-12T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: DEV_TWO,
                    submittedAt: "2026-07-09T00:00:00Z",
                }),
            ]
        );
        const result = aggregate(handle);

        expect(result.team.latencySamplesDiscarded).toBe(1);
        expect(result.team.latencyMedianHours).toBeNull();
        expect(devNamed(result.devs, "dev-two")?.latencyMedianHours).toBeNull();
        // The review still happened, so the load it carries is untouched.
        expect(result.team.reviewsGiven).toBe(1);
        expect(render(result, "md")).toContain(
            "earlier than the opening of the pull request"
        );
    });
});

test("a review from a deleted account is described as one in the report", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(
            handle,
            [
                pullRequest({
                    id: "pr-1",
                    number: 1,
                    author: DEV_ONE,
                    createdAt: "2026-07-01T00:00:00Z",
                    mergedAt: "2026-07-02T00:00:00Z",
                }),
            ],
            [
                review({
                    id: "review-1",
                    pullRequest: "pr-1",
                    reviewer: null,
                    submittedAt: "2026-07-01T05:00:00Z",
                }),
            ]
        );
        const result = aggregate(handle);

        expect(result.unattributed.reviewsGiven).toBe(1);
        // The reviewer is neither a bot nor an unmapped login, which is all the
        // two sentences explaining the gap used to offer.
        const markdown = render(result, "md");
        expect(markdown).toContain("came from a bot, a deleted account,");
        expect(markdown).toContain(
            "The reviewer was a bot, a deleted account,"
        );
    });
});

test("a window whose merges carry no review reports zero coverage, not silence", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seed(handle, [
            pullRequest({
                id: "pr-1",
                number: 1,
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
                mergedAt: "2026-07-02T00:00:00Z",
            }),
        ]);
        const markdown = render(aggregate(handle), "md");

        expect(markdown).toContain(
            "Review coverage: 0 of 1 merged pull request(s) carry a review (0%)"
        );
        // A window with no review at all must not be explained away as bots or
        // unmapped logins, which is the other reason for having no per-dev rows.
        expect(markdown).toContain("no review counted in this window");
        expect(markdown).not.toContain("came from a bot");
    });
});
