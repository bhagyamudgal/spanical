import type { Database } from "bun:sqlite";
import { existsSync, rmSync, statSync } from "node:fs";
import { count, getTableName } from "drizzle-orm";
import { rebuildSchema, type CacheDatabase } from "./open";
import { cacheTables, extractions } from "./schema";

const SIZE_SUFFIXES = ["", "-wal"];
const CACHE_FILE_SUFFIXES = ["", "-wal", "-shm"];

export type TableCount = { table: string; count: number };
export type LastExtraction = { repo: string; extractedAt: number };

export type CacheStats = {
    path: string;
    fileSizeBytes: number;
    tableCounts: TableCount[];
    lastExtractions: LastExtraction[];
};

function computeFileSize(path: string): number {
    return SIZE_SUFFIXES.reduce((total, suffix) => {
        const filePath = `${path}${suffix}`;
        return existsSync(filePath) ? total + statSync(filePath).size : total;
    }, 0);
}

export function gatherCacheStats(db: CacheDatabase, path: string): CacheStats {
    const tableCounts = cacheTables.map((table) => {
        const row = db.select({ value: count() }).from(table).get();
        return { table: getTableName(table), count: row?.value ?? 0 };
    });
    const lastExtractions = db
        .select({
            repo: extractions.repo,
            extractedAt: extractions.extractedAt,
        })
        .from(extractions)
        .all();
    return {
        path,
        fileSizeBytes: computeFileSize(path),
        tableCounts,
        lastExtractions,
    };
}

export function formatCacheStats(stats: CacheStats): string {
    const lines = [
        `Cache: ${stats.path}`,
        `Size: ${stats.fileSizeBytes} bytes`,
        "Rows:",
    ];
    for (const entry of stats.tableCounts) {
        lines.push(`  ${entry.table}: ${entry.count}`);
    }
    lines.push("Last extraction:");
    if (stats.lastExtractions.length === 0) {
        lines.push("  never");
    } else {
        for (const extraction of stats.lastExtractions) {
            const timestamp = new Date(extraction.extractedAt).toISOString();
            lines.push(`  ${extraction.repo}: ${timestamp}`);
        }
    }
    return lines.join("\n");
}

export function rebuildCache(sqlite: Database): void {
    rebuildSchema(sqlite);
}

export function clearCache(path: string): void {
    for (const suffix of CACHE_FILE_SUFFIXES) {
        rmSync(`${path}${suffix}`, { force: true });
    }
}
