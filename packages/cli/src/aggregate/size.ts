import { and, eq, inArray, sql } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { sccSnapshots } from "../cache/schema";
import type { SizeTrendPoint } from "./types";

type MonthAccumulator = {
    totalCode: number;
    totalComplexity: number;
    languages: { language: string; code: number }[];
};

export function aggregateSizeTrend(
    db: CacheDatabase,
    opts: { repo?: string; repos?: string[] }
): SizeTrendPoint[] {
    const rows = db
        .select({
            month: sccSnapshots.month,
            language: sccSnapshots.language,
            code: sql<number>`coalesce(sum(${sccSnapshots.code}), 0)`,
            complexity: sql<number>`coalesce(sum(${sccSnapshots.complexity}), 0)`,
        })
        .from(sccSnapshots)
        .where(
            and(
                eq(sccSnapshots.isBoundary, true),
                opts.repo ? eq(sccSnapshots.repo, opts.repo) : undefined,
                opts.repos && opts.repos.length > 0
                    ? inArray(sccSnapshots.repo, opts.repos)
                    : undefined
            )
        )
        .groupBy(sccSnapshots.month, sccSnapshots.language)
        .all();

    const byMonth = new Map<string, MonthAccumulator>();
    for (const row of rows) {
        const accumulator = byMonth.get(row.month) ?? {
            totalCode: 0,
            totalComplexity: 0,
            languages: [],
        };
        accumulator.totalCode += row.code;
        accumulator.totalComplexity += row.complexity;
        accumulator.languages.push({ language: row.language, code: row.code });
        byMonth.set(row.month, accumulator);
    }

    return [...byMonth.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([month, accumulator]) => ({
            month,
            totalCode: accumulator.totalCode,
            totalComplexity: accumulator.totalComplexity,
            languages: accumulator.languages.sort((left, right) =>
                left.language.localeCompare(right.language)
            ),
        }));
}
