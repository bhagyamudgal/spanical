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
    lineDeaths,
} from "../cache/schema";
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
        reworkLines: null,
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
        reworkLines: null,
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
        reworkLines: null,
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

test("aggregatePerDev repo-qualifies filesTouched across repos sharing a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "spanical-aggregate-multi-"));
    const handle = openCache({ cwd: dir });
    const { db } = handle;
    try {
        db.insert(authors)
            .values([{ id: 1, canonicalName: "dev-one" }])
            .run();
        db.insert(commits)
            .values([
                {
                    sha: "w1",
                    repo: "web-app",
                    authorId: 1,
                    authoredAt: Date.UTC(2025, 5, 10),
                    isMerge: false,
                },
                {
                    sha: "a1",
                    repo: "api",
                    authorId: 1,
                    authoredAt: Date.UTC(2025, 5, 12),
                    isMerge: false,
                },
            ])
            .run();
        db.insert(commitAuthors)
            .values([
                { sha: "w1", authorId: 1, weight: 1.0 },
                { sha: "a1", authorId: 1, weight: 1.0 },
            ])
            .run();
        db.insert(fileChanges)
            .values([
                {
                    sha: "w1",
                    repo: "web-app",
                    path: "src/index.ts",
                    added: 10,
                    deleted: 0,
                    isBinary: false,
                    isMigration: false,
                },
                {
                    sha: "a1",
                    repo: "api",
                    path: "src/index.ts",
                    added: 5,
                    deleted: 0,
                    isBinary: false,
                    isMigration: false,
                },
            ])
            .run();

        const rollups = aggregatePerDev(db, {
            periods: [P1],
            timezone: "UTC",
            repos: ["web-app", "api"],
        });

        expect(rollups).toHaveLength(1);
        expect(rollups[0]?.filesTouched).toBe(2);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregatePerDev charges rework to the victim author inside the window only", () => {
    const { handle, dir } = seedFixture();
    try {
        const { db } = handle;
        // c2 kills on 2025-07-05. A victim born 2025-06-20 is 15 days old and
        // inside the 21-day window; one born 2025-06-01 is 34 days out; a
        // third death on c3 (2025-07-20) charges dev-two, but its victim is
        // 66 days old, so the window excludes it too.
        db.insert(lineDeaths)
            .values([
                {
                    repo: "web-app",
                    sha: "c2",
                    path: "src/a.ts",
                    victimSha: "v1",
                    victimAuthorId: 1,
                    victimAuthoredAt: Date.UTC(2025, 5, 20),
                    lines: 7,
                },
                {
                    repo: "web-app",
                    sha: "c2",
                    path: "src/b.ts",
                    victimSha: "v2",
                    victimAuthorId: 1,
                    victimAuthoredAt: Date.UTC(2025, 5, 1),
                    lines: 100,
                },
                {
                    repo: "web-app",
                    sha: "c3",
                    path: "src/c.ts",
                    victimSha: "v3",
                    victimAuthorId: 2,
                    victimAuthoredAt: Date.UTC(2025, 4, 15),
                    lines: 50,
                },
            ])
            .run();

        const rollups = aggregatePerDev(handle.db, {
            periods: [P1, P2],
            timezone: "UTC",
            repo: "web-app",
            reworkWindowDays: 21,
        });

        const devOneJuly = rollups.find(
            (rollup) => rollup.period === "2025-07" && rollup.authorId === 1
        );
        expect(devOneJuly?.reworkLines).toBe(7);
        const devTwoJuly = rollups.find(
            (rollup) => rollup.period === "2025-07" && rollup.authorId === 2
        );
        expect(devTwoJuly?.reworkLines).toBe(0);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregatePerDev reports rework as null when no rework window is passed", () => {
    const { handle, dir } = seedFixture();
    try {
        const { db } = handle;
        db.insert(lineDeaths)
            .values({
                repo: "web-app",
                sha: "c2",
                path: "src/a.ts",
                victimSha: "v1",
                victimAuthorId: 1,
                victimAuthoredAt: Date.UTC(2025, 5, 20),
                lines: 7,
            })
            .run();

        const rollups = aggregatePerDev(handle.db, {
            periods: [P2],
            timezone: "UTC",
            repo: "web-app",
        });

        for (const rollup of rollups) {
            expect(rollup.reworkLines).toBeNull();
        }
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
        ["reworkLines", "context"],
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
