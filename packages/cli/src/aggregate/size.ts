import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { sccSnapshots } from "../cache/schema";
import type { SnapshotResult } from "../scc";
import type { SizeTrendPoint } from "./types";

type MonthAccumulator = {
    totalCode: number;
    totalComplexity: number;
    languages: { language: string; code: number }[];
};

type SnapshotAccumulator = {
    totalCode: number;
    totalComplexity: number;
    languages: Map<string, number>;
};

type SizeTrendOptions = {
    repo?: string;
    repos?: string[];
    months?: string[];
    snapshots?: SnapshotResult[];
};

function emptySnapshotAccumulator(): SnapshotAccumulator {
    return { totalCode: 0, totalComplexity: 0, languages: new Map() };
}

function aggregateCachedSizeTrend(
    db: CacheDatabase,
    opts: SizeTrendOptions
): SizeTrendPoint[] {
    if (opts.months?.length === 0) {
        return [];
    }
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
                    : undefined,
                opts.months
                    ? inArray(sccSnapshots.month, opts.months)
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

function aggregateSelectedSizeTrend(
    db: CacheDatabase,
    opts: SizeTrendOptions,
    snapshots: SnapshotResult[]
): SizeTrendPoint[] {
    const selectedRepos =
        opts.repo === undefined ? new Set(opts.repos) : new Set([opts.repo]);
    const selectedMonths =
        opts.months === undefined ? null : new Set(opts.months);
    const selections = snapshots.flatMap((result) => {
        if (selectedRepos.size > 0 && !selectedRepos.has(result.repo)) {
            return [];
        }
        return result.snapshots
            .filter(
                (snapshot) =>
                    selectedMonths === null ||
                    selectedMonths.has(snapshot.month)
            )
            .map((snapshot) => ({ repo: result.repo, snapshot }));
    });

    const measuredShasByRepo = new Map<string, Set<string>>();
    for (const { repo, snapshot } of selections) {
        if (snapshot.status !== "measured") {
            continue;
        }
        const shas = measuredShasByRepo.get(repo) ?? new Set<string>();
        shas.add(snapshot.sha);
        measuredShasByRepo.set(repo, shas);
    }
    const snapshotFilters = [...measuredShasByRepo].map(([repo, shas]) =>
        and(eq(sccSnapshots.repo, repo), inArray(sccSnapshots.sha, [...shas]))
    );
    const rows =
        snapshotFilters.length === 0
            ? []
            : db
                  .select({
                      repo: sccSnapshots.repo,
                      sha: sccSnapshots.sha,
                      language: sccSnapshots.language,
                      code: sql<number>`coalesce(sum(${sccSnapshots.code}), 0)`,
                      complexity: sql<number>`coalesce(sum(${sccSnapshots.complexity}), 0)`,
                  })
                  .from(sccSnapshots)
                  .where(or(...snapshotFilters))
                  .groupBy(
                      sccSnapshots.repo,
                      sccSnapshots.sha,
                      sccSnapshots.language
                  )
                  .all();

    const sizeByRepo = new Map<string, Map<string, SnapshotAccumulator>>();
    for (const row of rows) {
        const sizeBySha = sizeByRepo.get(row.repo) ?? new Map();
        const accumulator =
            sizeBySha.get(row.sha) ?? emptySnapshotAccumulator();
        accumulator.totalCode += row.code;
        accumulator.totalComplexity += row.complexity;
        accumulator.languages.set(row.language, row.code);
        sizeBySha.set(row.sha, accumulator);
        sizeByRepo.set(row.repo, sizeBySha);
    }

    const byMonth = new Map<string, SnapshotAccumulator>();
    for (const { repo, snapshot } of selections) {
        if (snapshot.status === "no-commit") {
            continue;
        }
        const month = byMonth.get(snapshot.month) ?? emptySnapshotAccumulator();
        if (snapshot.status === "measured") {
            const measured = sizeByRepo.get(repo)?.get(snapshot.sha);
            if (measured === undefined) {
                throw new Error(
                    `Measured SCC snapshot ${repo}@${snapshot.sha} is missing from the cache`
                );
            }
            month.totalCode += measured.totalCode;
            month.totalComplexity += measured.totalComplexity;
            for (const [language, code] of measured.languages) {
                month.languages.set(
                    language,
                    (month.languages.get(language) ?? 0) + code
                );
            }
        }
        byMonth.set(snapshot.month, month);
    }

    return [...byMonth.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([month, accumulator]) => ({
            month,
            totalCode: accumulator.totalCode,
            totalComplexity: accumulator.totalComplexity,
            languages: [...accumulator.languages]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([language, code]) => ({ language, code })),
        }));
}

export function aggregateSizeTrend(
    db: CacheDatabase,
    opts: SizeTrendOptions
): SizeTrendPoint[] {
    return opts.snapshots === undefined
        ? aggregateCachedSizeTrend(db, opts)
        : aggregateSelectedSizeTrend(db, opts, opts.snapshots);
}
