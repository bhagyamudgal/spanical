import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    aggregateAll,
    aggregateComplexityAttribution,
    aggregateHotspots,
    aggregateOwnership,
    aggregatePerDev,
    aggregateTimeline,
} from "../aggregate";
import { openCache } from "../cache/open";
import {
    authorGithubLogins,
    authors,
    commitAuthors,
    commits,
    extractions,
    fileChanges,
    fileOwnership,
    githubSyncs,
    reviews,
    sccSnapshots,
    tickets,
} from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import { parseConfig } from "../config/load";
import type { Period, ResolvedWindow } from "../window/types";
import { buildReportArtifact, type PerRepoInsight } from "./artifact";
import { defaultReportPath } from "./filename";
import {
    collectTicketInsight,
    type TicketRefresh,
    type TicketRefreshFailure,
} from "./ticket-layer";

const P1: Period = {
    label: "2025-06",
    start: new Date(Date.UTC(2025, 5, 1)),
    end: new Date(Date.UTC(2025, 6, 1)),
};
const P2: Period = {
    label: "2025-07",
    start: new Date(Date.UTC(2025, 6, 1)),
    end: new Date(Date.UTC(2025, 7, 1)),
};

const WINDOW: ResolvedWindow = {
    start: P1.start,
    end: P2.end,
    granularity: "month",
    periods: [P1, P2],
    label: "2025-06 – 2025-07",
};

const RUN: ResolvedRun = {
    repos: [{ name: "web-app", path: "/tmp/web-app" }],
    config: parseConfig({ repos: [{ name: "web-app", path: "/tmp/web-app" }] }),
    tz: "UTC",
    exclude: [],
    by: "dev",
    format: "md",
    out: null,
    cache: true,
    window: WINDOW,
};

const MIN_FILE_LINES = 10;
const BUS_FACTOR_THRESHOLD = 0.8;
const WINDOW_END_SHAS = new Map([["web-app", "c2"]]);
const BASELINE_SHAS = new Map<string, string>();

function seedFixture(): { handle: ReturnType<typeof openCache>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "spanical-report-"));
    const handle = openCache({ cwd: dir });
    const { db } = handle;

    db.insert(authors)
        .values([
            { id: 1, canonicalName: "dev-one" },
            { id: 2, canonicalName: "dev-two" },
        ])
        .run();

    db.insert(commits)
        .values([
            {
                sha: "c1",
                repo: "web-app",
                authorId: 1,
                authoredAt: Date.UTC(2025, 5, 10),
                isMerge: false,
            },
            {
                sha: "c2",
                repo: "web-app",
                authorId: 1,
                authoredAt: Date.UTC(2025, 6, 5),
                isMerge: false,
            },
            {
                sha: "c3",
                repo: "web-app",
                authorId: 2,
                authoredAt: Date.UTC(2025, 6, 20),
                isMerge: false,
            },
            {
                sha: "c4",
                repo: "web-app",
                authorId: 1,
                authoredAt: Date.UTC(2025, 6, 25),
                isMerge: false,
            },
        ])
        .run();

    db.insert(commitAuthors)
        .values([
            { sha: "c1", authorId: 1, weight: 1.0 },
            { sha: "c2", authorId: 1, weight: 0.5 },
            { sha: "c2", authorId: 2, weight: 0.5 },
            { sha: "c3", authorId: 2, weight: 1.0 },
            { sha: "c4", authorId: 1, weight: 1.0 },
        ])
        .run();

    db.insert(fileChanges)
        .values([
            {
                sha: "c1",
                repo: "web-app",
                path: "src/a.ts",
                added: 10,
                deleted: 2,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c2",
                repo: "web-app",
                path: "src/a.ts",
                added: 5,
                deleted: 5,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c2",
                repo: "web-app",
                path: "src/b.ts",
                added: 20,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c3",
                repo: "web-app",
                path: "db/migrations/001.sql",
                added: 100,
                deleted: 0,
                isBinary: false,
                isMigration: true,
            },
            {
                sha: "c3",
                repo: "web-app",
                path: "src/c.ts",
                added: 3,
                deleted: 1,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c3",
                repo: "web-app",
                path: "assets/x.png",
                added: null,
                deleted: null,
                isBinary: true,
                isMigration: false,
            },
            {
                sha: "c4",
                repo: "web-app",
                path: "db/migrations/002.sql",
                added: 50,
                deleted: 0,
                isBinary: false,
                isMigration: true,
            },
        ])
        .run();

    db.insert(sccSnapshots)
        .values([
            {
                repo: "web-app",
                month: "2025-06",
                path: "src/a.ts",
                language: "TypeScript",
                code: 20,
                complexity: 3,
                sha: "c1",
                isBoundary: true,
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "src/a.ts",
                language: "TypeScript",
                code: 25,
                complexity: 4,
                sha: "c2",
                isBoundary: true,
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "src/b.ts",
                language: "TypeScript",
                code: 30,
                complexity: 5,
                sha: "c2",
                isBoundary: true,
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "db/migrations/001.sql",
                language: "SQL",
                code: 8,
                complexity: 0,
                sha: "c2",
                isBoundary: true,
            },
        ])
        .run();

    db.insert(extractions)
        .values({
            repo: "web-app",
            branch: "main",
            tipSha: "c2",
            since: null,
            configKey: "empty",
            extractedAt: Date.UTC(2025, 6, 6),
        })
        .run();

    db.insert(fileOwnership)
        .values([
            {
                repo: "web-app",
                headSha: "c2",
                path: "src/a.ts",
                authorId: 1,
                survivingLines: 25,
            },
            {
                repo: "web-app",
                headSha: "c2",
                path: "src/b.ts",
                authorId: 1,
                survivingLines: 20,
            },
            {
                repo: "web-app",
                headSha: "c2",
                path: "src/b.ts",
                authorId: 2,
                survivingLines: 10,
            },
        ])
        .run();

    return { handle, dir };
}

const DEV_ONE_LOGIN = "dev-one-gh";
const DEV_TWO_LOGIN = "dev-two-gh";

const TICKET_REFRESH: TicketRefresh = {
    attribution: "assignee",
    includeIssues: false,
    failure: null,
};

function seedTickets(handle: ReturnType<typeof openCache>): void {
    const { db } = handle;
    db.insert(authorGithubLogins)
        .values([
            { login: DEV_ONE_LOGIN, authorId: 1 },
            { login: DEV_TWO_LOGIN, authorId: 2 },
        ])
        .run();

    db.insert(tickets)
        .values([
            {
                nodeId: "pr-1",
                repo: "web-app",
                kind: "pr",
                number: 1,
                title: "feat: app",
                author: DEV_ONE_LOGIN,
                authorIsBot: false,
                assignee: DEV_ONE_LOGIN,
                assigneeIsBot: false,
                closedBy: DEV_ONE_LOGIN,
                closedByIsBot: false,
                createdAt: Date.UTC(2025, 5, 10),
                closedAt: Date.UTC(2025, 5, 12),
                mergedAt: Date.UTC(2025, 5, 12),
                updatedAt: Date.UTC(2025, 5, 12),
                state: "MERGED",
                reopenedCount: 0,
                additions: 40,
                deletions: 10,
            },
            {
                nodeId: "pr-2",
                repo: "web-app",
                kind: "pr",
                number: 2,
                title: "feat: api",
                author: DEV_TWO_LOGIN,
                authorIsBot: false,
                assignee: DEV_TWO_LOGIN,
                assigneeIsBot: false,
                closedBy: DEV_TWO_LOGIN,
                closedByIsBot: false,
                createdAt: Date.UTC(2025, 6, 5),
                closedAt: Date.UTC(2025, 6, 6),
                mergedAt: Date.UTC(2025, 6, 6),
                updatedAt: Date.UTC(2025, 6, 6),
                state: "MERGED",
                reopenedCount: 0,
                additions: 5,
                deletions: 1,
            },
        ])
        .run();

    db.insert(reviews)
        .values([
            {
                nodeId: "review-1",
                prNodeId: "pr-1",
                reviewer: DEV_TWO_LOGIN,
                reviewerIsBot: false,
                submittedAt: Date.UTC(2025, 5, 11),
                requestedAt: Date.UTC(2025, 5, 10),
                state: "APPROVED",
            },
            {
                nodeId: "review-2",
                prNodeId: "pr-2",
                reviewer: DEV_ONE_LOGIN,
                reviewerIsBot: false,
                submittedAt: Date.UTC(2025, 6, 6),
                requestedAt: Date.UTC(2025, 6, 5),
                state: "APPROVED",
            },
        ])
        .run();
}

function seedOutOfWindowTicket(
    handle: ReturnType<typeof openCache>,
    reviewSubmittedAt?: number
): void {
    handle.db
        .insert(tickets)
        .values({
            nodeId: "pr-before-window",
            repo: "web-app",
            kind: "pr",
            number: 3,
            title: "feat: earlier work",
            author: DEV_ONE_LOGIN,
            authorIsBot: false,
            assignee: DEV_ONE_LOGIN,
            assigneeIsBot: false,
            closedBy: DEV_ONE_LOGIN,
            closedByIsBot: false,
            createdAt: Date.UTC(2025, 4, 1),
            closedAt: Date.UTC(2025, 4, 2),
            mergedAt: Date.UTC(2025, 4, 2),
            updatedAt: Date.UTC(2025, 4, 2),
            state: "MERGED",
            reopenedCount: 0,
            additions: 20,
            deletions: 5,
        })
        .run();
    if (reviewSubmittedAt === undefined) {
        return;
    }
    handle.db
        .insert(reviews)
        .values({
            nodeId: "review-in-window",
            prNodeId: "pr-before-window",
            reviewer: DEV_TWO_LOGIN,
            reviewerIsBot: false,
            submittedAt: reviewSubmittedAt,
            requestedAt: Date.UTC(2025, 5, 9),
            state: "APPROVED",
        })
        .run();
}

function seedSyncFloor(
    handle: ReturnType<typeof openCache>,
    since: string
): void {
    handle.db
        .insert(githubSyncs)
        .values({
            repo: "web-app",
            slug: "acme/web-app",
            since,
            syncedThrough: Date.UTC(2025, 6, 1),
            issuesSyncedThrough: Date.UTC(2025, 6, 1),
            syncedAt: Date.UTC(2025, 6, 1),
        })
        .run();
}

function buildArtifact(
    handle: ReturnType<typeof openCache>,
    refresh: TicketRefresh | null = null
): string {
    const { db } = handle;
    const full = aggregateAll(db, {
        window: WINDOW,
        timezone: "UTC",
        repos: ["web-app"],
    });
    const contributors = aggregatePerDev(db, {
        periods: [{ label: WINDOW.label, start: P1.start, end: P2.end }],
        timezone: "UTC",
    });
    const hotspots = aggregateHotspots(db, {
        window: WINDOW,
        repos: ["web-app"],
        minFileLines: MIN_FILE_LINES,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
        windowEndShas: WINDOW_END_SHAS,
    });
    const ownership = aggregateOwnership(db, {
        repos: ["web-app"],
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
    });
    const complexity = aggregateComplexityAttribution(db, {
        window: WINDOW,
        windowStart: P1.start,
        repos: ["web-app"],
        timezone: "UTC",
        minFileLines: MIN_FILE_LINES,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
        windowEndShas: WINDOW_END_SHAS,
        baselineShas: BASELINE_SHAS,
        perDev: contributors,
    });
    const perRepoInsights: PerRepoInsight[] = full.perRepo.map(
        ({ repo, aggregation }) => {
            const repoContributors = aggregatePerDev(db, {
                periods: [
                    { label: WINDOW.label, start: P1.start, end: P2.end },
                ],
                timezone: "UTC",
                repo,
            });
            return {
                repo,
                aggregation,
                contributors: repoContributors,
                hotspots: aggregateHotspots(db, {
                    window: WINDOW,
                    repos: [repo],
                    minFileLines: MIN_FILE_LINES,
                    busFactorThreshold: BUS_FACTOR_THRESHOLD,
                    windowEndShas: WINDOW_END_SHAS,
                }),
                ownership: aggregateOwnership(db, {
                    repos: [repo],
                    busFactorThreshold: BUS_FACTOR_THRESHOLD,
                }),
                complexity: aggregateComplexityAttribution(db, {
                    window: WINDOW,
                    windowStart: P1.start,
                    repos: [repo],
                    timezone: "UTC",
                    minFileLines: MIN_FILE_LINES,
                    busFactorThreshold: BUS_FACTOR_THRESHOLD,
                    windowEndShas: WINDOW_END_SHAS,
                    baselineShas: BASELINE_SHAS,
                    perDev: repoContributors,
                }),
                timeline: [],
            };
        }
    );
    return buildReportArtifact({
        full,
        contributors,
        hotspots,
        ownership,
        complexity,
        timeline: [],
        perRepoInsights,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
        tickets:
            refresh === null
                ? null
                : {
                      combined: collectTicketInsight(db, RUN, refresh, [
                          "web-app",
                      ]),
                      byRepo: new Map([
                          [
                              "web-app",
                              collectTicketInsight(db, RUN, refresh, [
                                  "web-app",
                              ]),
                          ],
                      ]),
                      failure: refresh.failure,
                  },
        run: RUN,
    });
}

const MULTI_WINDOW_END_SHAS = new Map([
    ["web", "w2"],
    ["api", "a2"],
]);

function seedMultiRepoFixture(): {
    handle: ReturnType<typeof openCache>;
    dir: string;
} {
    const dir = mkdtempSync(join(tmpdir(), "spanical-report-multi-"));
    const handle = openCache({ cwd: dir });
    const { db } = handle;

    db.insert(authors)
        .values([
            { id: 1, canonicalName: "dev-one" },
            { id: 2, canonicalName: "dev-two" },
        ])
        .run();

    db.insert(commits)
        .values([
            {
                sha: "w1",
                repo: "web",
                authorId: 1,
                authoredAt: Date.UTC(2025, 5, 10),
                isMerge: false,
            },
            {
                sha: "w2",
                repo: "web",
                authorId: 1,
                authoredAt: Date.UTC(2025, 6, 5),
                isMerge: false,
            },
            {
                sha: "a1",
                repo: "api",
                authorId: 2,
                authoredAt: Date.UTC(2025, 5, 12),
                isMerge: false,
            },
            {
                sha: "a2",
                repo: "api",
                authorId: 2,
                authoredAt: Date.UTC(2025, 6, 6),
                isMerge: false,
            },
        ])
        .run();

    db.insert(commitAuthors)
        .values([
            { sha: "w1", authorId: 1, weight: 1.0 },
            { sha: "w2", authorId: 1, weight: 1.0 },
            { sha: "a1", authorId: 2, weight: 1.0 },
            { sha: "a2", authorId: 2, weight: 1.0 },
        ])
        .run();

    db.insert(fileChanges)
        .values([
            {
                sha: "w1",
                repo: "web",
                path: "src/home.ts",
                added: 40,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "w2",
                repo: "web",
                path: "src/home.ts",
                added: 30,
                deleted: 10,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "w2",
                repo: "web",
                path: "src/list.ts",
                added: 20,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "a1",
                repo: "api",
                path: "src/route.ts",
                added: 8,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "a2",
                repo: "api",
                path: "src/route.ts",
                added: 2,
                deleted: 1,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "a2",
                repo: "api",
                path: "src/db.ts",
                added: 5,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
        ])
        .run();

    db.insert(sccSnapshots)
        .values([
            {
                repo: "web",
                month: "2025-07",
                path: "src/home.ts",
                language: "TypeScript",
                code: 100,
                complexity: 10,
                sha: "w2",
                isBoundary: true,
            },
            {
                repo: "web",
                month: "2025-07",
                path: "src/list.ts",
                language: "TypeScript",
                code: 100,
                complexity: 4,
                sha: "w2",
                isBoundary: true,
            },
            {
                repo: "api",
                month: "2025-07",
                path: "src/route.ts",
                language: "TypeScript",
                code: 100,
                complexity: 8,
                sha: "a2",
                isBoundary: true,
            },
            {
                repo: "api",
                month: "2025-07",
                path: "src/db.ts",
                language: "TypeScript",
                code: 100,
                complexity: 2,
                sha: "a2",
                isBoundary: true,
            },
        ])
        .run();

    db.insert(extractions)
        .values([
            {
                repo: "web",
                branch: "main",
                tipSha: "w2",
                since: null,
                configKey: "empty",
                extractedAt: Date.UTC(2025, 6, 6),
            },
            {
                repo: "api",
                branch: "main",
                tipSha: "a2",
                since: null,
                configKey: "empty",
                extractedAt: Date.UTC(2025, 6, 7),
            },
        ])
        .run();

    db.insert(fileOwnership)
        .values([
            {
                repo: "web",
                headSha: "w2",
                path: "src/home.ts",
                authorId: 1,
                survivingLines: 100,
            },
            {
                repo: "web",
                headSha: "w2",
                path: "src/list.ts",
                authorId: 1,
                survivingLines: 100,
            },
            {
                repo: "api",
                headSha: "a2",
                path: "src/route.ts",
                authorId: 2,
                survivingLines: 100,
            },
            {
                repo: "api",
                headSha: "a2",
                path: "src/db.ts",
                authorId: 2,
                survivingLines: 100,
            },
        ])
        .run();

    return { handle, dir };
}

function seedWebOnlyTickets(handle: ReturnType<typeof openCache>): void {
    handle.db
        .insert(tickets)
        .values({
            nodeId: "pr-web-1",
            repo: "web",
            kind: "pr",
            number: 1,
            title: "feat: home",
            author: DEV_ONE_LOGIN,
            authorIsBot: false,
            assignee: DEV_ONE_LOGIN,
            assigneeIsBot: false,
            closedBy: DEV_ONE_LOGIN,
            closedByIsBot: false,
            createdAt: Date.UTC(2025, 6, 5),
            closedAt: Date.UTC(2025, 6, 6),
            mergedAt: Date.UTC(2025, 6, 6),
            updatedAt: Date.UTC(2025, 6, 6),
            state: "MERGED",
            reopenedCount: 0,
            additions: 30,
            deletions: 10,
        })
        .run();
}

async function buildMultiRepoArtifact(
    handle: ReturnType<typeof openCache>,
    dir: string,
    refresh: TicketRefresh | null = null
): Promise<string> {
    const { db } = handle;
    const repos = ["web", "api"];
    const run: ResolvedRun = {
        ...RUN,
        repos: [
            { name: "web", path: dir },
            { name: "api", path: dir },
        ],
    };
    const period = { label: WINDOW.label, start: P1.start, end: P2.end };
    const full = aggregateAll(db, { window: WINDOW, timezone: "UTC", repos });
    const contributors = aggregatePerDev(db, {
        periods: [period],
        timezone: "UTC",
    });
    const hotspots = aggregateHotspots(db, {
        window: WINDOW,
        repos,
        minFileLines: MIN_FILE_LINES,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
        windowEndShas: MULTI_WINDOW_END_SHAS,
    });
    const ownership = aggregateOwnership(db, {
        repos,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
    });
    const complexity = aggregateComplexityAttribution(db, {
        window: WINDOW,
        windowStart: P1.start,
        repos,
        timezone: "UTC",
        minFileLines: MIN_FILE_LINES,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
        windowEndShas: MULTI_WINDOW_END_SHAS,
        baselineShas: BASELINE_SHAS,
        perDev: contributors,
    });
    const timeline = await aggregateTimeline(db, {
        window: WINDOW,
        repos: run.repos,
    });
    const pathByRepo = new Map(run.repos.map((repo) => [repo.name, repo.path]));
    const perRepoInsights: PerRepoInsight[] = await Promise.all(
        full.perRepo.map(async ({ repo, aggregation }) => {
            const repoPath = pathByRepo.get(repo);
            const repoContributors = aggregatePerDev(db, {
                periods: [period],
                timezone: "UTC",
                repo,
            });
            return {
                repo,
                aggregation,
                contributors: repoContributors,
                hotspots: aggregateHotspots(db, {
                    window: WINDOW,
                    repos: [repo],
                    minFileLines: MIN_FILE_LINES,
                    busFactorThreshold: BUS_FACTOR_THRESHOLD,
                    windowEndShas: MULTI_WINDOW_END_SHAS,
                }),
                ownership: aggregateOwnership(db, {
                    repos: [repo],
                    busFactorThreshold: BUS_FACTOR_THRESHOLD,
                }),
                complexity: aggregateComplexityAttribution(db, {
                    window: WINDOW,
                    windowStart: P1.start,
                    repos: [repo],
                    timezone: "UTC",
                    minFileLines: MIN_FILE_LINES,
                    busFactorThreshold: BUS_FACTOR_THRESHOLD,
                    windowEndShas: MULTI_WINDOW_END_SHAS,
                    baselineShas: BASELINE_SHAS,
                    perDev: repoContributors,
                }),
                timeline:
                    repoPath === undefined
                        ? []
                        : await aggregateTimeline(db, {
                              window: WINDOW,
                              repos: [{ name: repo, path: repoPath }],
                          }),
            };
        })
    );
    return buildReportArtifact({
        full,
        contributors,
        hotspots,
        ownership,
        complexity,
        timeline,
        perRepoInsights,
        busFactorThreshold: BUS_FACTOR_THRESHOLD,
        tickets:
            refresh === null
                ? null
                : {
                      combined: collectTicketInsight(db, run, refresh, repos),
                      byRepo: new Map(
                          repos.map((repo) => [
                              repo,
                              collectTicketInsight(db, run, refresh, [repo]),
                          ])
                      ),
                      failure: refresh.failure,
                  },
        run,
    });
}

test("buildReportArtifact composes the headline summary from the oracle fixture", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("# Engineering report — 2025-06 – 2025-07");

        expect(artifact).toContain("Net growth");
        expect(artifact).toContain("+30 LOC");
        expect(artifact).toContain("Total now");
        expect(artifact).toContain("63 LOC");
        expect(artifact).toContain("46 lines");
        expect(artifact).toContain("4 (no-merge)");
        expect(artifact).toContain("Active devs");
        expect(artifact).toContain("Busiest month");
        expect(artifact).toContain("2025-07");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact headline lists the top hotspots and a bus-factor warning", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("Top hotspots (refactor shortlist)");
        expect(artifact).toContain(
            "web-app/src/a.ts  churn 2 · cx 4 · owners 1"
        );
        expect(artifact).toContain(
            "web-app/src/b.ts  churn 1 · cx 5 · owners 2"
        );
        expect(artifact).toContain(
            "Bus-factor warnings: 1 file owned > 80% by a single dev in 1 dir"
        );
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact emits every section in narrative order", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        const order = [
            "## Activity by period",
            "## Timeline",
            "## Contributors",
            "## Hotspots",
            "## Ownership & bus-factor",
            "## Size & complexity",
            "## Migrations",
            "## Per-repo appendix",
        ].map((heading) => artifact.indexOf(heading));

        for (const index of order) {
            expect(index).toBeGreaterThanOrEqual(0);
        }
        const sorted = [...order].sort((left, right) => left - right);
        expect(order).toEqual(sorted);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact Contributors section includes the complexity table", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("## Contributors");
        expect(artifact).toContain("Complexity net");
        expect(artifact).toContain("Hotspot share");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact renders the activity table with the busiest period row", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);
        const activityRow = artifact
            .split("\n")
            .find((line) => line.startsWith("| 2025-07 |"));

        expect(activityRow).toBeDefined();
        expect(activityRow).toContain("| 3 |");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact reports migrations churn tracked separately", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain(
            "Migrations churn: +150 / -0 (150 lines, tracked separately from main churn)"
        );
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact lists both contributors with flag markers", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("dev-one");
        expect(artifact).toContain("dev-two");
        expect(artifact).toContain("(signal)");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact per-repo appendix repeats every section per repo", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);
        const appendix = artifact.slice(
            artifact.indexOf("## Per-repo appendix")
        );

        expect(appendix).toContain("### web-app");
        expect(appendix).toContain("#### Activity by period");
        expect(appendix).toContain("#### Hotspots");
        expect(appendix).toContain("#### Ownership & bus-factor");
        expect(appendix).toContain("#### Timeline");
        expect(appendix).toContain("#### Contributors");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact scopes each repo's appendix to that repo alone", async () => {
    const { handle, dir } = seedMultiRepoFixture();
    try {
        const artifact = await buildMultiRepoArtifact(handle, dir);

        const combinedTimeline = artifact.slice(
            artifact.indexOf("## Timeline"),
            artifact.indexOf("## Contributors")
        );
        expect(combinedTimeline).toContain("| 2025-07 | 46 | 68 |");

        const combinedHotspots = artifact.slice(
            artifact.indexOf("## Hotspots"),
            artifact.indexOf("## Ownership & bus-factor")
        );
        expect(combinedHotspots).toContain(
            "| api/src/route.ts | 2 | 8 | 0.750 | 1 |"
        );

        const appendix = artifact.slice(
            artifact.indexOf("## Per-repo appendix")
        );
        const webBlock = appendix.slice(
            appendix.indexOf("### web"),
            appendix.indexOf("### api")
        );
        const apiBlock = appendix.slice(appendix.indexOf("### api"));

        expect(webBlock).toContain("| 2025-07 | 40 | 60 |");
        expect(webBlock).not.toContain("| 2025-07 | 46 | 68 |");
        expect(webBlock).not.toContain("| 2025-07 | 6 | 8 |");
        expect(apiBlock).toContain("| 2025-07 | 6 | 8 |");
        expect(apiBlock).not.toContain("| 2025-07 | 46 | 68 |");
        expect(apiBlock).not.toContain("| 2025-07 | 40 | 60 |");

        expect(apiBlock).toContain("| api/src/route.ts | 2 | 8 | 1.000 | 1 |");
        expect(webBlock).toContain("web/src/home.ts");
        expect(webBlock).not.toContain("api/src/route.ts");
        expect(apiBlock).toContain("api/src/route.ts");
        expect(apiBlock).not.toContain("web/src/home.ts");

        expect(webBlock).toContain("dev-one");
        expect(webBlock).not.toContain("dev-two");
        expect(apiBlock).toContain("dev-two");
        expect(apiBlock).not.toContain("dev-one");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

function headlineOf(artifact: string): string {
    return artifact.slice(0, artifact.indexOf("## Timeline"));
}

function sizeOf(artifact: string): string {
    return artifact.slice(
        artifact.indexOf("## Size & complexity"),
        artifact.indexOf("## Migrations")
    );
}

test("buildReportArtifact omits the ticket sections when the ticket layer is off", () => {
    const { handle, dir } = seedFixture();
    try {
        seedTickets(handle);
        const artifact = buildArtifact(handle);

        expect(artifact).not.toContain("## Tickets");
        expect(artifact).not.toContain("## Reviews");
        expect(artifact).not.toContain("#### Tickets");
        expect(artifact).not.toContain("#### Reviews");
        expect(artifact).not.toContain("Review coverage");
        expect(artifact).toContain("## Contributors");
        expect(artifact).toContain("## Hotspots");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact renders ticket flow and review load in both views", () => {
    const { handle, dir } = seedFixture();
    try {
        seedTickets(handle);
        const artifact = buildArtifact(handle, TICKET_REFRESH);

        const combined = artifact.slice(
            artifact.indexOf("## Tickets"),
            artifact.indexOf("## Hotspots")
        );
        expect(combined).toContain("## Tickets");
        expect(combined).toContain(
            "### Ticket flow · credited to the assignee"
        );
        expect(combined).toContain("## Reviews");
        expect(combined).toContain("### Review load");
        expect(combined).toContain(
            "Team: 2 opened · 2 merged · 0 closed · 0 reopened · 0 reverted"
        );
        expect(combined).toContain(
            "Review coverage: 2 of 2 merged pull request(s) carry a review (100%)"
        );

        const appendix = artifact.slice(
            artifact.indexOf("## Per-repo appendix")
        );
        expect(appendix).toContain("#### Tickets");
        expect(appendix).toContain(
            "##### Ticket flow · credited to the assignee"
        );
        expect(appendix).toContain("#### Reviews");
        expect(appendix).toContain("##### Review load");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact keeps GitHub pull request sizes out of the churn totals", () => {
    const { handle, dir } = seedFixture();
    try {
        seedTickets(handle);
        const withTickets = buildArtifact(handle, TICKET_REFRESH);
        const withoutTickets = buildArtifact(handle);

        expect(headlineOf(withTickets)).toBe(headlineOf(withoutTickets));
        expect(sizeOf(withTickets)).toBe(sizeOf(withoutTickets));
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact names a failed refresh in every ticket section", () => {
    const { handle, dir } = seedFixture();
    try {
        seedTickets(handle);
        const failure: TicketRefreshFailure = {
            reason: "GitHub GraphQL pullRequests failed with status 503",
        };
        const artifact = buildArtifact(handle, { ...TICKET_REFRESH, failure });

        const warnings = artifact
            .split("\n")
            .filter((line) => line.startsWith("Warning: the GitHub refresh"));
        expect(warnings).toHaveLength(4);
        for (const warning of warnings) {
            expect(warning).toContain(
                "may be missing anything that changed since the last complete sync"
            );
            expect(warning).toContain("status 503");
        }
        expect(artifact).toContain("Team: 2 opened · 2 merged");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact says so when a failed refresh has no cache behind it", () => {
    const { handle, dir } = seedFixture();
    try {
        const failure: TicketRefreshFailure = {
            reason: "GITHUB_TOKEN was rejected (401)",
        };
        const artifact = buildArtifact(handle, { ...TICKET_REFRESH, failure });

        expect(artifact).toContain(
            "nothing is cached here to fall back on, so the ticket layer has nothing to report"
        );
        expect(artifact).toContain("No ticket activity in 2025-06 – 2025-07");
        expect(artifact).not.toContain("Team: 0 opened");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact scopes the failure wording to the repos each section reports", async () => {
    const { handle, dir } = seedMultiRepoFixture();
    try {
        seedWebOnlyTickets(handle);
        const failure: TicketRefreshFailure = { reason: "network unreachable" };
        const artifact = await buildMultiRepoArtifact(handle, dir, {
            ...TICKET_REFRESH,
            failure,
        });

        const appendix = artifact.slice(
            artifact.indexOf("## Per-repo appendix")
        );
        const webBlock = appendix.slice(
            appendix.indexOf("### web"),
            appendix.indexOf("### api")
        );
        const apiBlock = appendix.slice(appendix.indexOf("### api"));

        expect(webBlock).toContain(
            "may be missing anything that changed since the last complete sync"
        );
        expect(webBlock).not.toContain(
            "nothing is cached here to fall back on"
        );
        // api has no cached tickets of its own, so it must never claim a cache.
        expect(apiBlock).toContain("nothing is cached here to fall back on");
        expect(apiBlock).not.toContain(
            "may be missing anything that changed since the last complete sync"
        );
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact carries a late sync floor into the ticket sections", () => {
    const { handle, dir } = seedFixture();
    try {
        seedTickets(handle);
        seedSyncFloor(handle, "2025-07-01");
        const artifact = buildArtifact(handle, TICKET_REFRESH);

        const floorNotes = artifact
            .split("\n")
            .filter((line) =>
                line.startsWith(
                    "Note: the ticket cache was synced from a later date"
                )
            );
        expect(floorNotes).toHaveLength(4);
        expect(floorNotes[0]).toContain("web-app (2025-07-01)");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact omits ticket sections when the window is empty", () => {
    const { handle, dir } = seedFixture();
    try {
        seedOutOfWindowTicket(handle);
        seedSyncFloor(handle, "2025-07-01");
        const artifact = buildArtifact(handle, TICKET_REFRESH);

        expect(artifact).not.toContain("## Tickets");
        expect(artifact).not.toContain("## Reviews");
        expect(artifact).not.toContain("#### Tickets");
        expect(artifact).not.toContain("#### Reviews");
        expect(artifact).not.toContain("No tickets cached");
        expect(artifact).not.toContain("No reviews cached");
        expect(artifact).not.toContain(
            "Note: the ticket cache was synced from a later date"
        );
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact keeps both sections for review-only window activity", () => {
    const { handle, dir } = seedFixture();
    try {
        seedOutOfWindowTicket(handle, Date.UTC(2025, 5, 10));
        const artifact = buildArtifact(handle, TICKET_REFRESH);

        expect(artifact).toContain("## Tickets");
        expect(artifact).toContain("## Reviews");
        expect(artifact).toContain("review latency 24h median");
        expect(artifact).toContain("#### Tickets");
        expect(artifact).toContain("#### Reviews");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("defaultReportPath derives a start_end slug from window boundaries", () => {
    const window: ResolvedWindow = {
        start: new Date(Date.UTC(2025, 5, 1)),
        end: new Date(Date.UTC(2025, 6, 15)),
        granularity: "month",
        periods: [],
        label: "x",
    };

    expect(defaultReportPath(window, "UTC", "/tmp/work")).toBe(
        join("/tmp/work", "spanical-report-2025-06_2025-07.md")
    );
});

test("defaultReportPath uses a history slug when the window has no start", () => {
    const window: ResolvedWindow = {
        start: null,
        end: new Date(Date.UTC(2025, 6, 15)),
        granularity: "month",
        periods: [],
        label: "x",
    };

    expect(defaultReportPath(window, "UTC", "/tmp/work")).toBe(
        join("/tmp/work", "spanical-report-history_2025-07.md")
    );
});
