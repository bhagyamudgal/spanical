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
    authors,
    commitAuthors,
    commits,
    extractions,
    fileChanges,
    fileOwnership,
    sccSnapshots,
} from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import type { Period, ResolvedWindow } from "../window/types";
import { buildReportArtifact, type PerRepoInsight } from "./artifact";
import { defaultReportPath } from "./filename";

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

function buildArtifact(handle: ReturnType<typeof openCache>): string {
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
                extractedAt: Date.UTC(2025, 6, 6),
            },
            {
                repo: "api",
                branch: "main",
                tipSha: "a2",
                since: null,
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

async function buildMultiRepoArtifact(
    handle: ReturnType<typeof openCache>,
    dir: string
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
            "Bus-factor warnings: 1 files owned > 80% by a single dev in 1 dirs"
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

        expect(apiBlock).toContain(
            "| api/src/route.ts | 2 | 8 | 1.000 | 1 |"
        );
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
