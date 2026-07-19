import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, getTableColumns, getTableName } from "drizzle-orm";
import { CACHE_INDEX_NAMES } from "./ddl";
import { CACHE_SCHEMA_VERSION, openCache, resolveCachePath } from "./open";
import { authors, cacheTables, extractions } from "./schema";
import {
    clearCache,
    formatCacheStats,
    gatherCacheStats,
    rebuildCache,
} from "./stats";

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), "spanical-cache-"));
}

function readSingleColumn(
    handle: ReturnType<typeof openCache>,
    sql: string
): string[] {
    return handle.sqlite
        .query<{ name: string }, []>(sql)
        .all()
        .map((row) => row.name);
}

test("openCache creates the db, sets the version and WAL, and creates every table", () => {
    const dir = makeTempDir();
    try {
        const handle = openCache({ cwd: dir });
        const expectedPath = join(dir, ".spanical", "cache.db");
        expect(handle.path).toBe(expectedPath);
        expect(existsSync(expectedPath)).toBe(true);

        const version = handle.sqlite
            .query<Record<string, number>, []>("PRAGMA user_version")
            .get();
        expect(version?.["user_version"]).toBe(CACHE_SCHEMA_VERSION);

        const journal = handle.sqlite
            .query<Record<string, string>, []>("PRAGMA journal_mode")
            .get();
        expect(journal?.["journal_mode"]).toBe("wal");

        const tableNames = readSingleColumn(
            handle,
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        );
        for (const table of cacheTables) {
            expect(tableNames).toContain(getTableName(table));
        }
        handle.sqlite.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("each table's columns match the Drizzle schema and expected indices exist", () => {
    const dir = makeTempDir();
    try {
        const handle = openCache({ cwd: dir });

        for (const table of cacheTables) {
            const tableName = getTableName(table);
            const actualColumns = handle.sqlite
                .query<{ name: string; type: string }, []>(
                    `PRAGMA table_info(${tableName})`
                )
                .all()
                .map((row) => `${row.name}:${row.type.toUpperCase()}`)
                .sort();
            const expectedColumns = Object.values(getTableColumns(table))
                .map(
                    (column) =>
                        `${column.name}:${column.getSQLType().toUpperCase()}`
                )
                .sort();
            expect(actualColumns).toEqual(expectedColumns);
        }

        const indexNames: string[] = [];
        for (const table of cacheTables) {
            const names = readSingleColumn(
                handle,
                `PRAGMA index_list(${getTableName(table)})`
            );
            indexNames.push(...names);
        }
        for (const expected of CACHE_INDEX_NAMES) {
            expect(indexNames).toContain(expected);
        }
        handle.sqlite.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a version mismatch drops the old data and rebuilds at the current version", () => {
    const dir = makeTempDir();
    try {
        const first = openCache({ cwd: dir });
        first.db.insert(authors).values({ canonicalName: "dev-one" }).run();
        first.sqlite.exec("PRAGMA user_version = 999;");
        first.sqlite.close();

        const second = openCache({ cwd: dir });
        const version = second.sqlite
            .query<Record<string, number>, []>("PRAGMA user_version")
            .get();
        expect(version?.["user_version"]).toBe(CACHE_SCHEMA_VERSION);

        const remaining = second.db
            .select({ value: count() })
            .from(authors)
            .get();
        expect(remaining?.value).toBe(0);
        second.sqlite.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("rebuildCache empties every table while keeping them present", () => {
    const dir = makeTempDir();
    try {
        const handle = openCache({ cwd: dir });
        handle.db.insert(authors).values({ canonicalName: "dev-one" }).run();

        rebuildCache(handle.sqlite);

        const stats = gatherCacheStats(handle.db, handle.path);
        for (const entry of stats.tableCounts) {
            expect(entry.count).toBe(0);
        }
        expect(stats.tableCounts).toHaveLength(cacheTables.length);
        handle.sqlite.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("clearCache deletes the db file and its sidecars", () => {
    const dir = makeTempDir();
    try {
        const handle = openCache({ cwd: dir });
        handle.db.insert(authors).values({ canonicalName: "dev-one" }).run();
        handle.sqlite.close();

        clearCache(handle.path);

        expect(existsSync(handle.path)).toBe(false);
        expect(existsSync(`${handle.path}-wal`)).toBe(false);
        expect(existsSync(`${handle.path}-shm`)).toBe(false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("gatherCacheStats counts rows and formatCacheStats renders them", () => {
    const dir = makeTempDir();
    try {
        const handle = openCache({ cwd: dir });
        handle.db
            .insert(authors)
            .values([
                { canonicalName: "dev-one" },
                { canonicalName: "dev-two" },
            ])
            .run();

        const extractedAt = Date.UTC(2025, 6, 1, 12, 0, 0);
        handle.db
            .insert(extractions)
            .values({
                repo: "web-app",
                branch: "main",
                tipSha: "abc123",
                since: null,
                extractedAt,
            })
            .run();

        const stats = gatherCacheStats(handle.db, handle.path);
        const authorCount = stats.tableCounts.find(
            (entry) => entry.table === "authors"
        );
        expect(authorCount?.count).toBe(2);
        expect(stats.lastExtractions).toEqual([
            { repo: "web-app", extractedAt },
        ]);
        expect(stats.fileSizeBytes).toBeGreaterThan(0);

        const formatted = formatCacheStats(stats);
        expect(formatted).toContain("authors: 2");
        expect(formatted).toContain("web-app: 2025-07-01T12:00:00.000Z");
        handle.sqlite.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveCachePath places the db under the resolved config directory", () => {
    expect(
        resolveCachePath({ configPath: "/tmp/project/spanical.config.ts" })
    ).toBe("/tmp/project/.spanical/cache.db");
    expect(
        resolveCachePath({
            configPath: "spanical.config.ts",
            cwd: "/tmp/project",
        })
    ).toBe("/tmp/project/.spanical/cache.db");
    expect(resolveCachePath({ cwd: "/tmp/project" })).toBe(
        "/tmp/project/.spanical/cache.db"
    );
});
