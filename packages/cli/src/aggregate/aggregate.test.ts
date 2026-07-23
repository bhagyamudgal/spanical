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
import type { Period, ResolvedWindow } from "../window/types";
import { aggregateAll } from "./aggregate";

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
    label: "2025-06..2025-07",
};

function seedMultiRepo(): {
    handle: ReturnType<typeof openCache>;
    dir: string;
} {
    const dir = mkdtempSync(join(tmpdir(), "spanical-aggregate-all-"));
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
            {
                sha: "c5",
                repo: "api",
                authorId: 2,
                authoredAt: Date.UTC(2025, 6, 15),
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
            { sha: "c5", authorId: 2, weight: 1.0 },
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
                sha: "c3",
                repo: "web-app",
                path: "src/c.ts",
                added: 3,
                deleted: 1,
                isBinary: false,
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
            {
                sha: "c5",
                repo: "api",
                path: "api/x.ts",
                added: 7,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
        ])
        .run();

    db.insert(sccSnapshots)
        .values([
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
                repo: "api",
                month: "2025-07",
                path: "api/x.ts",
                language: "TypeScript",
                code: 100,
                complexity: 10,
                sha: "c5",
                isBoundary: true,
            },
        ])
        .run();

    return { handle, dir };
}

test("aggregateAll splits combined and per-repo scopes", () => {
    const { handle, dir } = seedMultiRepo();
    try {
        const full = aggregateAll(handle.db, {
            window: WINDOW,
            timezone: "UTC",
            repos: ["web-app", "api"],
        });

        expect(full.combined.summary.commits).toBe(5);

        const webApp = full.perRepo.find((entry) => entry.repo === "web-app");
        const api = full.perRepo.find((entry) => entry.repo === "api");
        expect(webApp?.aggregation.summary.commits).toBe(4);
        expect(api?.aggregation.summary.commits).toBe(1);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregateAll scopes the combined summary to the requested repos", () => {
    const { handle, dir } = seedMultiRepo();
    try {
        const { combined } = aggregateAll(handle.db, {
            window: WINDOW,
            timezone: "UTC",
            repos: ["web-app"],
        });

        expect(combined.summary.commits).toBe(4);
        expect(combined.summary.totalSizeNow).toBe(25);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregateAll scopes the combined perPeriod rollup to the requested repos", () => {
    const { handle, dir } = seedMultiRepo();
    try {
        const { combined } = aggregateAll(handle.db, {
            window: WINDOW,
            timezone: "UTC",
            repos: ["web-app"],
        });

        const secondPeriod = combined.perPeriod.find(
            (row) => row.period === "2025-07"
        );
        expect(secondPeriod?.commits).toBe(3);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregateAll scopes the combined perDev rollup to the requested repos", () => {
    const { handle, dir } = seedMultiRepo();
    try {
        const { combined } = aggregateAll(handle.db, {
            window: WINDOW,
            timezone: "UTC",
            repos: ["web-app"],
        });

        const devTwoSecond = combined.perDev.find(
            (row) => row.period === "2025-07" && row.author === "dev-two"
        );
        expect(devTwoSecond?.added).toBe(5.5);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("aggregateAll scopes the combined sizeTrend to the requested repos", () => {
    const { handle, dir } = seedMultiRepo();
    try {
        const { combined } = aggregateAll(handle.db, {
            window: WINDOW,
            timezone: "UTC",
            repos: ["web-app"],
        });

        expect(combined.sizeTrend.at(-1)?.totalCode).toBe(25);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
