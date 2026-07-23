import type { CacheDatabase } from "../cache/open";
import type { Period, ResolvedWindow } from "../window/types";
import { aggregatePerDev } from "./per-dev";
import { aggregatePerPeriod } from "./per-period";
import { aggregateSizeTrend } from "./size";
import { aggregateSummary } from "./summary";
import type { FullAggregation, RepoAggregation } from "./types";

function aggregateScope(
    db: CacheDatabase,
    opts: {
        periods: Period[];
        timezone: string;
        repo?: string;
        repos?: string[];
    }
): RepoAggregation {
    return {
        summary: aggregateSummary(db, {
            periods: opts.periods,
            repo: opts.repo,
            repos: opts.repos,
        }),
        perPeriod: aggregatePerPeriod(db, {
            periods: opts.periods,
            repo: opts.repo,
            repos: opts.repos,
        }),
        perDev: aggregatePerDev(db, {
            periods: opts.periods,
            timezone: opts.timezone,
            repo: opts.repo,
            repos: opts.repos,
        }),
        sizeTrend: aggregateSizeTrend(db, {
            repo: opts.repo,
            repos: opts.repos,
        }),
    };
}

export function aggregateAll(
    db: CacheDatabase,
    opts: { window: ResolvedWindow; timezone: string; repos: string[] }
): FullAggregation {
    const { periods } = opts.window;
    const combined = aggregateScope(db, {
        periods,
        timezone: opts.timezone,
        repos: opts.repos,
    });
    const perRepo = opts.repos.map((repo) => ({
        repo,
        aggregation: aggregateScope(db, {
            periods,
            timezone: opts.timezone,
            repo,
        }),
    }));

    return { combined, perRepo };
}
