import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { tryCatchSync } from "@spanical/utils";
import { resolveConfigPath } from "../config/load";
import { CREATE_INDEX_STATEMENTS, CREATE_TABLE_STATEMENTS } from "./ddl";
import { CacheError, CACHE_ERROR_CODES } from "./errors";
import { cacheSchema, CACHE_TABLE_NAMES } from "./schema";

export const CACHE_SCHEMA_VERSION = 1;

const CACHE_DIR_NAME = ".spanical";
const CACHE_DB_NAME = "cache.db";
const USER_VERSION_KEY = "user_version";

export type CacheDatabase = BunSQLiteDatabase<typeof cacheSchema>;

export type CacheHandle = {
    db: CacheDatabase;
    sqlite: Database;
    path: string;
};

type CacheOptions = { configPath?: string; cwd?: string };

export function resolveCachePath(options: CacheOptions = {}): string {
    const configDir = dirname(resolveConfigPath(options));
    return join(configDir, CACHE_DIR_NAME, CACHE_DB_NAME);
}

function readUserVersion(sqlite: Database): number {
    const row = sqlite
        .query<Record<string, number>, []>("PRAGMA user_version")
        .get();
    return row?.[USER_VERSION_KEY] ?? 0;
}

export function rebuildSchema(sqlite: Database): void {
    const dropStatements = [...CACHE_TABLE_NAMES]
        .reverse()
        .map((name) => `DROP TABLE IF EXISTS ${name};`);
    const statements = [
        ...dropStatements,
        ...CREATE_TABLE_STATEMENTS,
        ...CREATE_INDEX_STATEMENTS,
        `PRAGMA user_version = ${CACHE_SCHEMA_VERSION};`,
    ];
    sqlite.exec(statements.join("\n"));
}

function initializeCache(path: string): {
    db: CacheDatabase;
    sqlite: Database;
} {
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = new Database(path);
    sqlite.exec("PRAGMA journal_mode = WAL;");
    const db = drizzle(sqlite, { schema: cacheSchema });
    if (readUserVersion(sqlite) !== CACHE_SCHEMA_VERSION) {
        rebuildSchema(sqlite);
    }
    return { db, sqlite };
}

export function openCache(options: CacheOptions = {}): CacheHandle {
    const path = resolveCachePath(options);
    const { data, error } = tryCatchSync(() => initializeCache(path));
    if (error) {
        throw new CacheError(
            CACHE_ERROR_CODES.OPEN_FAILED,
            `Failed to open cache at ${path}: ${error.message}`,
            { cause: error }
        );
    }
    return { db: data.db, sqlite: data.sqlite, path };
}
