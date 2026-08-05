import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tryCatch } from "@spanical/utils";
import { openCache } from "../cache/open";
import { githubSyncs, reviews, tickets } from "../cache/schema";
import { parseConfig } from "../config/load";
import type { SpanicalConfig } from "../config/schema";
import type { GraphQLTransport } from "./client";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";
import { bridgeGithubLogins, findUnmappedLogins } from "./identity";
import { syncTickets } from "./sync";

const REPO_NAME = "web-app";
const SLUG = "acme/web";
const RATE_LIMIT = {
    cost: 3,
    remaining: 4_999,
    resetAt: "2026-07-19T13:00:00Z",
};
const FIRST_RUN = new Date("2026-07-19T12:00:00Z");
const SECOND_RUN = new Date("2026-07-26T12:00:00Z");
const WATERMARK_SAFETY_MS = 60 * 60 * 1000;
const HUMAN = { login: "dev-one-gh", typename: "User" };
const REVIEWER = { login: "dev-two-gh", typename: "User" };
const BOT = { login: "renovate", typename: "Bot" };

type Handle = ReturnType<typeof openCache>;
type Actor = { login: string; typename: string } | null;
// requestedReviewer carries no login when a team rather than a user was asked.
type ReviewRequest = {
    createdAt: string;
    requestedReviewer: { login?: string } | null;
};
type Review = {
    id: string;
    state: string;
    submittedAt: string | null;
    author: Actor;
};
type PageInfo = { hasNextPage: boolean; endCursor: string | null };

const LAST_PAGE: PageInfo = { hasNextPage: false, endCursor: null };

function ticketFields(options: {
    id: string;
    number: number;
    updatedAt: string;
    author: Actor;
    title?: string;
    createdAt?: string;
    closedAt?: string | null;
    assignee?: Actor;
    closedBy?: Actor;
    reopenedCount?: number;
}) {
    return {
        id: options.id,
        number: options.number,
        title: options.title ?? `ticket ${options.number}`,
        state: "OPEN",
        createdAt: options.createdAt ?? options.updatedAt,
        updatedAt: options.updatedAt,
        closedAt: options.closedAt ?? null,
        author: options.author,
        assignees: { nodes: options.assignee ? [options.assignee] : [] },
        reopened: { filteredCount: options.reopenedCount ?? 0 },
        closed: {
            nodes: options.closedBy ? [{ actor: options.closedBy }] : [],
        },
    };
}

function pullRequestNode(options: {
    id: string;
    number: number;
    updatedAt: string;
    author: Actor;
    title?: string;
    createdAt?: string;
    mergedAt?: string | null;
    assignee?: Actor;
    closedBy?: Actor;
    reopenedCount?: number;
    requests?: ReviewRequest[];
    requestsFilteredCount?: number;
    reviews?: (Review | null)[];
    reviewsTotalCount?: number;
}) {
    const reviewNodes = options.reviews ?? [];
    const requestNodes = options.requests ?? [];
    return {
        ...ticketFields(options),
        mergedAt: options.mergedAt ?? null,
        additions: 12,
        deletions: 3,
        requests: {
            filteredCount: options.requestsFilteredCount ?? requestNodes.length,
            nodes: requestNodes,
        },
        reviews: {
            totalCount: options.reviewsTotalCount ?? reviewNodes.length,
            nodes: reviewNodes,
        },
    };
}

function pullRequestPage(
    nodes: ReturnType<typeof pullRequestNode>[],
    pageInfo: PageInfo = LAST_PAGE
) {
    return {
        rateLimit: RATE_LIMIT,
        repository: { pullRequests: { pageInfo, nodes } },
    };
}

function issuePage(
    nodes: ReturnType<typeof ticketFields>[],
    pageInfo: PageInfo = LAST_PAGE
) {
    return {
        rateLimit: RATE_LIMIT,
        repository: { issues: { pageInfo, nodes } },
    };
}

type CannedPages = { pullRequests: unknown[]; issues?: unknown[] };

function cannedTransport(pages: CannedPages): {
    transport: GraphQLTransport;
    cursors: (string | null)[];
} {
    const cursors: (string | null)[] = [];
    let pullRequestIndex = 0;
    let issueIndex = 0;
    const transport: GraphQLTransport = (_url, init) => {
        const isPullRequestQuery = init.body.includes("pullRequests(");
        const page = isPullRequestQuery
            ? pages.pullRequests[pullRequestIndex]
            : (pages.issues ?? [])[issueIndex];
        if (page === undefined) {
            return Promise.reject(
                new Error("canned transport ran out of pages")
            );
        }
        if (isPullRequestQuery) {
            cursors.push(readCursor(init.body));
            pullRequestIndex += 1;
        } else {
            issueIndex += 1;
        }
        return Promise.resolve(
            new Response(JSON.stringify({ data: page }), { status: 200 })
        );
    };
    return { transport, cursors };
}

function readCursor(body: string): string | null {
    const parsed: unknown = JSON.parse(body);
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("variables" in parsed)
    ) {
        throw new Error("request body carried no variables");
    }
    const { variables } = parsed;
    if (
        typeof variables !== "object" ||
        variables === null ||
        !("cursor" in variables)
    ) {
        throw new Error("request variables carried no cursor");
    }
    const { cursor } = variables;
    return typeof cursor === "string" ? cursor : null;
}

function buildConfig(includeIssues = false): SpanicalConfig {
    return parseConfig({
        repos: [{ name: REPO_NAME, path: "/unused", github: SLUG }],
        tickets: {
            source: "github",
            github: { token: "env:GITHUB_TOKEN", includeIssues },
        },
    });
}

async function withCache<T>(fn: (handle: Handle) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "spanical-gh-sync-"));
    const handle = openCache({ cwd: dir });
    try {
        return await fn(handle);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

function runSync(
    handle: Handle,
    config: SpanicalConfig,
    transport: GraphQLTransport,
    now: Date
) {
    return syncTickets(handle.db, config, {
        token: "test-token",
        now,
        transport,
    });
}

test("a two-page response upserts every ticket and review row", async () => {
    await withCache(async (handle) => {
        const { transport, cursors } = cannedTransport({
            pullRequests: [
                pullRequestPage(
                    [
                        pullRequestNode({
                            id: "pr-1",
                            number: 1,
                            updatedAt: "2026-07-18T10:00:00Z",
                            createdAt: "2026-07-15T09:00:00Z",
                            mergedAt: "2026-07-18T10:00:00Z",
                            assignee: REVIEWER,
                            closedBy: HUMAN,
                            reopenedCount: 2,
                            author: HUMAN,
                            requests: [
                                {
                                    createdAt: "2026-07-16T08:00:00Z",
                                    requestedReviewer: {
                                        login: REVIEWER.login,
                                    },
                                },
                                {
                                    createdAt: "2026-07-16T07:00:00Z",
                                    requestedReviewer: {},
                                },
                            ],
                            reviews: [
                                {
                                    id: "review-1",
                                    state: "APPROVED",
                                    submittedAt: "2026-07-17T08:00:00Z",
                                    author: REVIEWER,
                                },
                            ],
                        }),
                    ],
                    { hasNextPage: true, endCursor: "page-2" }
                ),
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-2",
                        number: 2,
                        updatedAt: "2026-07-10T10:00:00Z",
                        author: HUMAN,
                        reviews: [
                            {
                                id: "review-2",
                                state: "COMMENTED",
                                submittedAt: "2026-07-10T09:00:00Z",
                                author: REVIEWER,
                            },
                        ],
                    }),
                ]),
            ],
        });

        const result = await runSync(
            handle,
            buildConfig(),
            transport,
            FIRST_RUN
        );

        expect(cursors).toEqual([null, "page-2"]);
        expect(result.repos).toEqual([
            { repo: REPO_NAME, slug: SLUG, ticketCount: 2, reviewCount: 2 },
        ]);

        const rows = handle.db.select().from(tickets).all();
        expect(rows).toHaveLength(2);
        const merged = rows.find((row) => row.nodeId === "pr-1");
        expect(merged?.repo).toBe(REPO_NAME);
        expect(merged?.kind).toBe("pr");
        expect(merged?.author).toBe(HUMAN.login);
        expect(merged?.authorIsBot).toBe(false);
        expect(merged?.assignee).toBe(REVIEWER.login);
        expect(merged?.assigneeIsBot).toBe(false);
        expect(merged?.closedBy).toBe(HUMAN.login);
        expect(merged?.reopenedCount).toBe(2);
        expect(merged?.additions).toBe(12);
        expect(merged?.mergedAt).toBe(Date.parse("2026-07-18T10:00:00Z"));

        const reviewRows = handle.db.select().from(reviews).all();
        expect(reviewRows).toHaveLength(2);
        expect(
            reviewRows.find((row) => row.nodeId === "review-1")?.requestedAt
        ).toBe(Date.parse("2026-07-16T08:00:00Z"));
        // No review-request event, so the latency basis derives as "created".
        expect(
            reviewRows.find((row) => row.nodeId === "review-2")?.requestedAt
        ).toBeNull();

        const cursor = handle.db
            .select()
            .from(githubSyncs)
            .where(eq(githubSyncs.repo, REPO_NAME))
            .get();
        expect(cursor?.slug).toBe(SLUG);
        expect(cursor?.syncedAt).toBe(FIRST_RUN.getTime());
        // The stored floor trails the clock so skew and mid-walk reordering
        // cannot drop a ticket permanently.
        expect(cursor?.syncedThrough).toBe(
            FIRST_RUN.getTime() - WATERMARK_SAFETY_MS
        );
    });
});

test("a re-request pairs the second review with the second request", async () => {
    await withCache(async (handle) => {
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                        requests: [
                            {
                                createdAt: "2026-07-01T08:00:00Z",
                                requestedReviewer: { login: REVIEWER.login },
                            },
                            {
                                createdAt: "2026-07-15T08:00:00Z",
                                requestedReviewer: { login: REVIEWER.login },
                            },
                        ],
                        reviews: [
                            {
                                id: "review-early",
                                state: "CHANGES_REQUESTED",
                                submittedAt: "2026-07-02T08:00:00Z",
                                author: REVIEWER,
                            },
                            {
                                id: "review-late",
                                state: "APPROVED",
                                submittedAt: "2026-07-16T08:00:00Z",
                                author: REVIEWER,
                            },
                        ],
                    }),
                ]),
            ],
        });

        await runSync(handle, buildConfig(), transport, FIRST_RUN);

        const rows = handle.db.select().from(reviews).all();
        expect(
            rows.find((row) => row.nodeId === "review-early")?.requestedAt
        ).toBe(Date.parse("2026-07-01T08:00:00Z"));
        expect(
            rows.find((row) => row.nodeId === "review-late")?.requestedAt
        ).toBe(Date.parse("2026-07-15T08:00:00Z"));
    });
});

test("a second sync over the cursor updates rows instead of duplicating them", async () => {
    await withCache(async (handle) => {
        const first = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        title: "feat: first draft",
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                        reviews: [
                            {
                                id: "review-1",
                                state: "CHANGES_REQUESTED",
                                submittedAt: "2026-07-18T09:00:00Z",
                                author: REVIEWER,
                            },
                        ],
                    }),
                ]),
            ],
        });
        await runSync(handle, buildConfig(), first.transport, FIRST_RUN);

        const second = cannedTransport({
            pullRequests: [
                pullRequestPage(
                    [
                        pullRequestNode({
                            id: "pr-1",
                            number: 1,
                            title: "feat: merged",
                            updatedAt: "2026-07-25T10:00:00Z",
                            mergedAt: "2026-07-25T10:00:00Z",
                            author: HUMAN,
                            reviews: [
                                {
                                    id: "review-1",
                                    state: "APPROVED",
                                    submittedAt: "2026-07-25T09:00:00Z",
                                    author: REVIEWER,
                                },
                            ],
                        }),
                        // Older than the cursor: stops the walk before page two.
                        pullRequestNode({
                            id: "pr-0",
                            number: 0,
                            updatedAt: "2026-07-01T10:00:00Z",
                            author: HUMAN,
                        }),
                    ],
                    { hasNextPage: true, endCursor: "page-2" }
                ),
            ],
        });
        const result = await runSync(
            handle,
            buildConfig(),
            second.transport,
            SECOND_RUN
        );

        expect(result.repos[0]?.ticketCount).toBe(1);
        expect(second.cursors).toEqual([null]);

        const rows = handle.db.select().from(tickets).all();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.title).toBe("feat: merged");
        expect(rows[0]?.mergedAt).toBe(Date.parse("2026-07-25T10:00:00Z"));

        const reviewRows = handle.db.select().from(reviews).all();
        expect(reviewRows).toHaveLength(1);
        expect(reviewRows[0]?.state).toBe("APPROVED");
    });
});

test("turning includeIssues on backfills issues without re-fetching pull requests", async () => {
    await withCache(async (handle) => {
        const withoutIssues = cannedTransport({
            pullRequests: [pullRequestPage([])],
        });
        await runSync(
            handle,
            buildConfig(false),
            withoutIssues.transport,
            FIRST_RUN
        );
        const afterFirst = handle.db
            .select()
            .from(githubSyncs)
            .where(eq(githubSyncs.repo, REPO_NAME))
            .get();
        // The issue watermark must not advance while issues are switched off.
        expect(afterFirst?.issuesSyncedThrough).toBe(0);
        expect(afterFirst?.syncedThrough).toBe(
            FIRST_RUN.getTime() - WATERMARK_SAFETY_MS
        );

        const withIssues = cannedTransport({
            pullRequests: [pullRequestPage([])],
            issues: [
                issuePage([
                    ticketFields({
                        id: "issue-1",
                        number: 7,
                        // Long before the pull-request watermark: only a real
                        // issue backfill reaches it.
                        updatedAt: "2026-01-05T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });
        const result = await runSync(
            handle,
            buildConfig(true),
            withIssues.transport,
            SECOND_RUN
        );

        expect(result.repos[0]?.ticketCount).toBe(1);
        const row = handle.db.select().from(tickets).get();
        expect(row?.kind).toBe("issue");
        expect(row?.number).toBe(7);
        expect(row?.additions).toBeNull();
        expect(row?.mergedAt).toBeNull();
    });
});

test("turning includeIssues off drops the issue rows it stops refreshing", async () => {
    await withCache(async (handle) => {
        const withIssues = cannedTransport({
            pullRequests: [pullRequestPage([])],
            issues: [
                issuePage([
                    ticketFields({
                        id: "issue-1",
                        number: 7,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });
        await runSync(
            handle,
            buildConfig(true),
            withIssues.transport,
            FIRST_RUN
        );
        expect(handle.db.select().from(tickets).all()).toHaveLength(1);

        const withoutIssues = cannedTransport({
            pullRequests: [pullRequestPage([])],
        });
        await runSync(
            handle,
            buildConfig(false),
            withoutIssues.transport,
            SECOND_RUN
        );

        // Left behind, the issue would keep inflating every later count while
        // never being refreshed again.
        expect(handle.db.select().from(tickets).all()).toEqual([]);
        // The watermark returns to the since bound so re-enabling backfills.
        const cursor = handle.db
            .select()
            .from(githubSyncs)
            .where(eq(githubSyncs.repo, REPO_NAME))
            .get();
        expect(cursor?.issuesSyncedThrough).toBe(0);
    });
});

test("--no-cache re-walks from the since bound instead of the watermark", async () => {
    await withCache(async (handle) => {
        const first = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });
        await runSync(handle, buildConfig(), first.transport, FIRST_RUN);

        // Older than the watermark the first run wrote: a cached walk would
        // filter it out, so reaching it proves the floor was dropped.
        const second = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-0",
                        number: 2,
                        updatedAt: "2026-07-01T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });
        const result = await syncTickets(handle.db, buildConfig(), {
            token: "test-token",
            now: SECOND_RUN,
            transport: second.transport,
            isCacheEnabled: false,
        });

        expect(result.repos[0]?.ticketCount).toBe(1);
        expect(handle.db.select().from(tickets).all()).toHaveLength(2);
    });
});

test("repointing a repo at another slug purges its rows and re-backfills", async () => {
    await withCache(async (handle) => {
        const first = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "old-pr",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                        reviews: [
                            {
                                id: "old-review",
                                state: "APPROVED",
                                submittedAt: "2026-07-18T09:00:00Z",
                                author: REVIEWER,
                            },
                        ],
                    }),
                ]),
            ],
        });
        await runSync(handle, buildConfig(), first.transport, FIRST_RUN);
        expect(handle.db.select().from(tickets).all()).toHaveLength(1);
        expect(handle.db.select().from(reviews).all()).toHaveLength(1);

        const repointed = parseConfig({
            repos: [
                { name: REPO_NAME, path: "/unused", github: "acme/web-fork" },
            ],
            tickets: {
                source: "github",
                github: { token: "env:GITHUB_TOKEN", includeIssues: false },
            },
        });
        const second = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "new-pr",
                        number: 1,
                        // Older than the previous watermark: only a full
                        // re-backfill reaches it.
                        updatedAt: "2026-02-01T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });
        await runSync(handle, repointed, second.transport, SECOND_RUN);

        const rows = handle.db.select().from(tickets).all();
        expect(rows.map((row) => row.nodeId)).toEqual(["new-pr"]);
        // reviews.pr_node_id does not cascade, so the old review must be gone.
        expect(handle.db.select().from(reviews).all()).toHaveLength(0);
        expect(
            handle.db
                .select()
                .from(githubSyncs)
                .where(eq(githubSyncs.repo, REPO_NAME))
                .get()?.slug
        ).toBe("acme/web-fork");
    });
});

test("a deleted account stores a null actor without throwing", async () => {
    await withCache(async (handle) => {
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: null,
                        reviews: [
                            {
                                id: "review-1",
                                state: "APPROVED",
                                submittedAt: "2026-07-18T09:00:00Z",
                                author: null,
                            },
                        ],
                    }),
                ]),
            ],
        });

        const result = await runSync(
            handle,
            buildConfig(),
            transport,
            FIRST_RUN
        );

        expect(result.unmappedLogins).toEqual([]);
        const row = handle.db.select().from(tickets).get();
        expect(row?.author).toBeNull();
        expect(row?.authorIsBot).toBe(false);
        expect(row?.assignee).toBeNull();
        expect(handle.db.select().from(reviews).get()?.reviewer).toBeNull();
    });
});

test("bot actors keep the is_bot flag and never mint a provisional author", async () => {
    await withCache(async (handle) => {
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: BOT,
                        assignee: BOT,
                        reviews: [
                            {
                                id: "review-1",
                                state: "APPROVED",
                                submittedAt: "2026-07-18T09:00:00Z",
                                author: BOT,
                            },
                        ],
                    }),
                    pullRequestNode({
                        id: "pr-2",
                        number: 2,
                        updatedAt: "2026-07-17T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });

        const result = await runSync(
            handle,
            buildConfig(),
            transport,
            FIRST_RUN
        );

        expect(result.unmappedLogins).toEqual([HUMAN.login]);

        const botRow = handle.db
            .select()
            .from(tickets)
            .where(eq(tickets.nodeId, "pr-1"))
            .get();
        expect(botRow?.author).toBe(BOT.login);
        expect(botRow?.authorIsBot).toBe(true);
        expect(botRow?.assigneeIsBot).toBe(true);
        expect(handle.db.select().from(reviews).get()?.reviewerIsBot).toBe(
            true
        );
    });
});

test("an assignee who never authored or reviewed is still bridged and warned about", async () => {
    await withCache(async (handle) => {
        const config = parseConfig({
            repos: [{ name: REPO_NAME, path: "/unused", github: SLUG }],
            authors: {
                "dev-one": {
                    emails: ["dev-one@example.com"],
                    github: [HUMAN.login],
                },
            },
            tickets: {
                source: "github",
                github: { token: "env:GITHUB_TOKEN", includeIssues: false },
            },
        });
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                        assignee: { login: "planner-gh", typename: "User" },
                    }),
                ]),
            ],
        });

        const result = await runSync(handle, config, transport, FIRST_RUN);
        expect(result.unmappedLogins).toEqual(["planner-gh"]);
    });
});

test("the unmapped warning is derived from the cache, so a cached run still reports", async () => {
    await withCache(async (handle) => {
        const config = buildConfig();
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 1,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                    }),
                ]),
            ],
        });
        await runSync(handle, config, transport, FIRST_RUN);

        // A later run that fetches nothing still sees the split identity,
        // because the logins come from the cache rather than from run state.
        const resolver = bridgeGithubLogins(handle.db, config);
        expect(
            findUnmappedLogins(handle.db, [REPO_NAME], resolver.bridgedLogins())
        ).toEqual([HUMAN.login]);
    });
});

test("a config with no tickets section refuses to sync", async () => {
    await withCache(async (handle) => {
        const config = parseConfig({
            repos: [{ name: REPO_NAME, path: "/unused", github: SLUG }],
        });
        const { transport } = cannedTransport({ pullRequests: [] });
        const { error } = await tryCatch(
            runSync(handle, config, transport, FIRST_RUN)
        );
        expect(error).toBeInstanceOf(GitHubError);
        if (error instanceof GitHubError) {
            expect(error.code).toBe(GITHUB_ERROR_CODES.TICKETS_NOT_CONFIGURED);
        }
    });
});

test("a repo with no resolvable slug fails before any request is made", async () => {
    await withCache(async (handle) => {
        const originless = mkdtempSync(join(tmpdir(), "spanical-gh-plain-"));
        const init = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
            cwd: originless,
        });
        if (init.exitCode !== 0) {
            throw new Error(`git init failed: ${init.stderr.toString()}`);
        }
        try {
            const config = parseConfig({
                repos: [
                    { name: REPO_NAME, path: "/unused", github: SLUG },
                    { name: "api", path: originless },
                ],
                tickets: {
                    source: "github",
                    github: { token: "env:GITHUB_TOKEN", includeIssues: false },
                },
            });
            const { transport, cursors } = cannedTransport({
                pullRequests: [pullRequestPage([])],
            });
            const { error } = await tryCatch(
                runSync(handle, config, transport, FIRST_RUN)
            );
            expect(error).toBeInstanceOf(GitHubError);
            if (error instanceof GitHubError) {
                expect(error.code).toBe(GITHUB_ERROR_CODES.ORIGIN_MISSING);
            }
            expect(cursors).toEqual([]);
        } finally {
            rmSync(originless, { recursive: true, force: true });
        }
    });
});

async function captureStderr(run: () => Promise<void>): Promise<string> {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
        await run();
        return spy.mock.calls.map((call) => String(call[0])).join("");
    } finally {
        spy.mockRestore();
    }
}

test("a truncated reviews connection warns instead of silently dropping reviews", async () => {
    await withCache(async (handle) => {
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 42,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                        reviewsTotalCount: 130,
                        reviews: [
                            {
                                id: "review-1",
                                state: "APPROVED",
                                submittedAt: "2026-07-18T09:00:00Z",
                                author: REVIEWER,
                            },
                        ],
                    }),
                ]),
            ],
        });

        const output = await captureStderr(async () => {
            await runSync(handle, buildConfig(), transport, FIRST_RUN);
        });
        expect(output).toContain("web-app#42 has 130 review(s)");
        expect(output).toContain("129 more recent review(s) are missing");
    });
});

test("a truncated review-request connection warns about the latency basis", async () => {
    await withCache(async (handle) => {
        const { transport } = cannedTransport({
            pullRequests: [
                pullRequestPage([
                    pullRequestNode({
                        id: "pr-1",
                        number: 42,
                        updatedAt: "2026-07-18T10:00:00Z",
                        author: HUMAN,
                        requestsFilteredCount: 80,
                        requests: [
                            {
                                createdAt: "2026-07-16T08:00:00Z",
                                requestedReviewer: { login: REVIEWER.login },
                            },
                        ],
                    }),
                ]),
            ],
        });

        const output = await captureStderr(async () => {
            await runSync(handle, buildConfig(), transport, FIRST_RUN);
        });
        expect(output).toContain("web-app#42 has 80 review request(s)");
        expect(output).toContain('"created" latency basis');
    });
});

test("a null node in a page is skipped rather than aborting the sync", async () => {
    await withCache(async (handle) => {
        const { transport } = cannedTransport({
            pullRequests: [
                {
                    rateLimit: null,
                    repository: {
                        pullRequests: {
                            pageInfo: LAST_PAGE,
                            nodes: [
                                null,
                                pullRequestNode({
                                    id: "pr-1",
                                    number: 1,
                                    updatedAt: "2026-07-18T10:00:00Z",
                                    author: HUMAN,
                                    reviewsTotalCount: 1,
                                    reviews: [
                                        {
                                            id: "review-1",
                                            state: "APPROVED",
                                            submittedAt: "2026-07-18T09:00:00Z",
                                            author: REVIEWER,
                                        },
                                        null,
                                    ],
                                }),
                            ],
                        },
                    },
                },
            ],
        });

        const result = await runSync(
            handle,
            buildConfig(),
            transport,
            FIRST_RUN
        );
        expect(result.repos[0]?.ticketCount).toBe(1);
        expect(handle.db.select().from(reviews).all()).toHaveLength(1);
    });
});
