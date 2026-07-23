import { and, countDistinct, eq, gte, inArray, lt } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { commitAuthors, commits } from "../cache/schema";
import type { Period } from "../window/types";
import { aggregatePerPeriod } from "./per-period";
import { aggregateSizeTrend } from "./size";
import type { CodebaseSummary, PeriodRollup } from "./types";

type WindowBounds = { start: number; end: number };

function deriveWindowBounds(periods: Period[]): WindowBounds | null {
    if (periods.length === 0) {
        return null;
    }
    const starts = periods.map((period) => period.start.getTime());
    const ends = periods.map((period) => period.end.getTime());
    return { start: Math.min(...starts), end: Math.max(...ends) };
}

function queryActiveDevCount(
    db: CacheDatabase,
    bounds: WindowBounds,
    repo: string | undefined,
    repos: string[] | undefined
): number {
    const row = db
        .select({ devs: countDistinct(commitAuthors.authorId) })
        .from(commits)
        .innerJoin(commitAuthors, eq(commitAuthors.sha, commits.sha))
        .where(
            and(
                gte(commits.authoredAt, bounds.start),
                lt(commits.authoredAt, bounds.end),
                repo ? eq(commits.repo, repo) : undefined,
                repos && repos.length > 0
                    ? inArray(commits.repo, repos)
                    : undefined
            )
        )
        .get();
    return row?.devs ?? 0;
}

function findBusiestPeriod(perPeriod: PeriodRollup[]): string | null {
    let busiest: PeriodRollup | null = null;
    for (const row of perPeriod) {
        if (busiest === null || row.throughput > busiest.throughput) {
            busiest = row;
        }
    }
    return busiest?.period ?? null;
}

export function aggregateSummary(
    db: CacheDatabase,
    opts: { periods: Period[]; repo?: string; repos?: string[] }
): CodebaseSummary {
    const perPeriod = aggregatePerPeriod(db, {
        periods: opts.periods,
        repo: opts.repo,
        repos: opts.repos,
    });
    const sizeTrend = aggregateSizeTrend(db, {
        repo: opts.repo,
        repos: opts.repos,
    });

    const commitCount = perPeriod.reduce(
        (total, row) => total + row.commits,
        0
    );
    const netGrowth = perPeriod.reduce((total, row) => total + row.net, 0);
    const totalChurn = perPeriod.reduce(
        (total, row) => total + row.throughput,
        0
    );
    const migrationsAdded = perPeriod.reduce(
        (total, row) => total + row.migrationsAdded,
        0
    );
    const migrationsDeleted = perPeriod.reduce(
        (total, row) => total + row.migrationsDeleted,
        0
    );

    const windowBounds = deriveWindowBounds(opts.periods);
    const activeDevs =
        windowBounds === null
            ? 0
            : queryActiveDevCount(db, windowBounds, opts.repo, opts.repos);

    return {
        netGrowth,
        totalChurn,
        commits: commitCount,
        activeDevs,
        busiestPeriod: commitCount === 0 ? null : findBusiestPeriod(perPeriod),
        growthEfficiency: totalChurn === 0 ? null : netGrowth / totalChurn,
        migrations: {
            added: migrationsAdded,
            deleted: migrationsDeleted,
            throughput: migrationsAdded + migrationsDeleted,
        },
        totalSizeNow: sizeTrend.at(-1)?.totalCode ?? 0,
    };
}
