import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache/open";
import {
    authors,
    commitAuthors,
    commits,
    fileChanges,
    sccSnapshots,
} from "../cache/schema";
import type { Period } from "../window/types";
import { aggregatePerPeriod } from "./per-period";
import { aggregateSizeTrend } from "./size";
import { aggregateSummary } from "./summary";

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

function seedFixture(): { handle: ReturnType<typeof openCache>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "spanical-codebase-"));
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
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "src/a.ts",
                language: "TypeScript",
                code: 25,
                complexity: 4,
                sha: "c2",
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "src/b.ts",
                language: "TypeScript",
                code: 30,
                complexity: 5,
                sha: "c2",
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "db/migrations/001.sql",
                language: "SQL",
                code: 8,
                complexity: 0,
                sha: "c2",
            },
        ])
        .run();

    return { handle, dir };
}

test("aggregatePerPeriod computes unweighted codebase churn per period", () => {
    const { handle, dir } = seedFixture();
    try {
        const rollups = aggregatePerPeriod(handle.db, {
            periods: [P1, P2],
            repo: "web-app",
        });
        expect(rollups).toEqual([
            {
                period: "2025-06",
                commits: 1,
                added: 10,
                deleted: 2,
                net: 8,
                throughput: 12,
                migrationsAdded: 0,
                migrationsDeleted: 0,
            },
            {
                period: "2025-07",
                commits: 3,
                added: 28,
                deleted: 6,
                net: 22,
                throughput: 34,
                migrationsAdded: 150,
                migrationsDeleted: 0,
            },
        ]);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregateSummary rolls up the whole window against the oracle", () => {
    const { handle, dir } = seedFixture();
    try {
        const summary = aggregateSummary(handle.db, {
            periods: [P1, P2],
            repo: "web-app",
        });
        expect(summary.netGrowth).toBe(30);
        expect(summary.totalChurn).toBe(46);
        expect(summary.commits).toBe(4);
        expect(summary.activeDevs).toBe(2);
        expect(summary.busiestPeriod).toBe("2025-07");
        expect(summary.growthEfficiency).toBeCloseTo(0.6521739, 5);
        expect(summary.migrations).toEqual({
            added: 150,
            deleted: 0,
            throughput: 150,
        });
        expect(summary.totalSizeNow).toBe(63);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregateSizeTrend groups scc snapshots by month with language breakdown", () => {
    const { handle, dir } = seedFixture();
    try {
        const trend = aggregateSizeTrend(handle.db, { repo: "web-app" });
        expect(trend).toEqual([
            {
                month: "2025-06",
                totalCode: 20,
                totalComplexity: 3,
                languages: [{ language: "TypeScript", code: 20 }],
            },
            {
                month: "2025-07",
                totalCode: 63,
                totalComplexity: 9,
                languages: [
                    { language: "SQL", code: 8 },
                    { language: "TypeScript", code: 55 },
                ],
            },
        ]);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("empty cache yields null efficiency, null busiest period, and zero size", () => {
    const dir = mkdtempSync(join(tmpdir(), "spanical-codebase-empty-"));
    const handle = openCache({ cwd: dir });
    try {
        const summary = aggregateSummary(handle.db, { periods: [P1, P2] });
        expect(summary.growthEfficiency).toBeNull();
        expect(summary.busiestPeriod).toBeNull();
        expect(summary.totalSizeNow).toBe(0);

        const rollups = aggregatePerPeriod(handle.db, { periods: [P1, P2] });
        expect(rollups).toEqual([
            {
                period: "2025-06",
                commits: 0,
                added: 0,
                deleted: 0,
                net: 0,
                throughput: 0,
                migrationsAdded: 0,
                migrationsDeleted: 0,
            },
            {
                period: "2025-07",
                commits: 0,
                added: 0,
                deleted: 0,
                net: 0,
                throughput: 0,
                migrationsAdded: 0,
                migrationsDeleted: 0,
            },
        ]);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
