import { and, countDistinct, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { commits, fileChanges } from "../cache/schema";
import type { Period } from "../window/types";
import type { PeriodRollup } from "./types";

export type RangeBounds = {
    start: number;
    end: number;
    repo: string | undefined;
    repos?: string[];
};

export type ChurnTotals = {
    added: number;
    deleted: number;
    migrationsAdded: number;
    migrationsDeleted: number;
};

const EMPTY_CHURN: ChurnTotals = {
    added: 0,
    deleted: 0,
    migrationsAdded: 0,
    migrationsDeleted: 0,
};

function rangeFilter(bounds: RangeBounds) {
    return and(
        gte(commits.authoredAt, bounds.start),
        lt(commits.authoredAt, bounds.end),
        bounds.repo ? eq(commits.repo, bounds.repo) : undefined,
        bounds.repos && bounds.repos.length > 0
            ? inArray(commits.repo, bounds.repos)
            : undefined
    );
}

export function queryDistinctCommitCount(
    db: CacheDatabase,
    bounds: RangeBounds
): number {
    const row = db
        .select({ commits: countDistinct(commits.sha) })
        .from(commits)
        .where(rangeFilter(bounds))
        .get();
    return row?.commits ?? 0;
}

export function queryChurnTotals(
    db: CacheDatabase,
    bounds: RangeBounds
): ChurnTotals {
    const row = db
        .select({
            added: sql<number>`coalesce(sum(case when ${fileChanges.isMigration} = 0 and ${fileChanges.isBinary} = 0 then ${fileChanges.added} else 0 end), 0)`,
            deleted: sql<number>`coalesce(sum(case when ${fileChanges.isMigration} = 0 and ${fileChanges.isBinary} = 0 then ${fileChanges.deleted} else 0 end), 0)`,
            migrationsAdded: sql<number>`coalesce(sum(case when ${fileChanges.isMigration} = 1 then ${fileChanges.added} else 0 end), 0)`,
            migrationsDeleted: sql<number>`coalesce(sum(case when ${fileChanges.isMigration} = 1 then ${fileChanges.deleted} else 0 end), 0)`,
        })
        .from(commits)
        .innerJoin(fileChanges, eq(fileChanges.sha, commits.sha))
        .where(rangeFilter(bounds))
        .get();
    return row ?? EMPTY_CHURN;
}

export function aggregatePerPeriod(
    db: CacheDatabase,
    opts: { periods: Period[]; repo?: string; repos?: string[] }
): PeriodRollup[] {
    return opts.periods.map((period) => {
        const bounds: RangeBounds = {
            start: period.start.getTime(),
            end: period.end.getTime(),
            repo: opts.repo,
            repos: opts.repos,
        };
        const commitCount = queryDistinctCommitCount(db, bounds);
        const churn = queryChurnTotals(db, bounds);

        return {
            period: period.label,
            commits: commitCount,
            added: churn.added,
            deleted: churn.deleted,
            net: churn.added - churn.deleted,
            throughput: churn.added + churn.deleted,
            migrationsAdded: churn.migrationsAdded,
            migrationsDeleted: churn.migrationsDeleted,
        };
    });
}
