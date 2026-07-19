import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache/open";
import { authors, commitAuthors, commits, fileChanges } from "../cache/schema";
import type { Period } from "../window/types";
import {
    PER_DEV_METRICS,
    type PerDevMetricKey,
    type ReadFlag,
} from "./metrics";
import { aggregatePerDev } from "./per-dev";
import type { DevPeriodRollup } from "./types";

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
    const dir = mkdtempSync(join(tmpdir(), "spanical-aggregate-"));
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

    return { handle, dir };
}

const EXPECTED_ROLLUPS: DevPeriodRollup[] = [
    {
        period: "2025-06",
        authorId: 1,
        author: "dev-one",
        commits: 1,
        added: 10,
        deleted: 2,
        net: 8,
        throughput: 12,
        filesTouched: 1,
        avgCommitSize: 12,
        activeDays: 1,
    },
    {
        period: "2025-07",
        authorId: 1,
        author: "dev-one",
        commits: 2,
        added: 12.5,
        deleted: 2.5,
        net: 10,
        throughput: 15,
        filesTouched: 2,
        avgCommitSize: 7.5,
        activeDays: 2,
    },
    {
        period: "2025-07",
        authorId: 2,
        author: "dev-two",
        commits: 2,
        added: 15.5,
        deleted: 3.5,
        net: 12,
        throughput: 19,
        filesTouched: 3,
        avgCommitSize: 9.5,
        activeDays: 2,
    },
];

test("aggregatePerDev computes weighted per-dev rollups against the oracle", () => {
    const { handle, dir } = seedFixture();
    try {
        const rollups = aggregatePerDev(handle.db, {
            periods: [P1, P2],
            timezone: "UTC",
            repo: "web-app",
        });
        expect(rollups).toEqual(EXPECTED_ROLLUPS);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregatePerDev matches with repo omitted when only one repo exists", () => {
    const { handle, dir } = seedFixture();
    try {
        const withoutRepo = aggregatePerDev(handle.db, {
            periods: [P1, P2],
            timezone: "UTC",
        });
        expect(withoutRepo).toEqual(EXPECTED_ROLLUPS);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a period with no commits yields no rows", () => {
    const { handle, dir } = seedFixture();
    try {
        const empty: Period = {
            label: "2025-01",
            start: new Date(Date.UTC(2025, 0, 1)),
            end: new Date(Date.UTC(2025, 1, 1)),
        };
        const rollups = aggregatePerDev(handle.db, {
            periods: [empty],
            timezone: "UTC",
            repo: "web-app",
        });
        expect(rollups).toHaveLength(0);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("PER_DEV_METRICS carries every metric key with its spec read flag", () => {
    const expectedFlags: [PerDevMetricKey, ReadFlag][] = [
        ["commits", "trap"],
        ["added", "trap"],
        ["deleted", "trap"],
        ["net", "trap"],
        ["throughput", "context"],
        ["filesTouched", "context"],
        ["avgCommitSize", "signal"],
        ["activeDays", "signal"],
    ];
    const actualFlags = new Map(
        PER_DEV_METRICS.map((metric) => [metric.key, metric.flag])
    );

    expect(PER_DEV_METRICS).toHaveLength(expectedFlags.length);
    for (const [key, flag] of expectedFlags) {
        expect(actualFlags.get(key)).toBe(flag);
    }
});
