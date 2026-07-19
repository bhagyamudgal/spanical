import type { CacheDatabase } from "../cache/open";
import type { Period, ResolvedWindow } from "../window/types";
import { aggregatePerDev } from "./per-dev";
import { aggregatePerPeriod } from "./per-period";
import { aggregateSizeTrend } from "./size";
import { aggregateSummary } from "./summary";
import type { FullAggregation, RepoAggregation } from "./types";

function aggregateScope(
    db: CacheDatabase,
    opts: { periods: Period[]; timezone: string; repo?: string }
): RepoAggregation {
    return {
        summary: aggregateSummary(db, {
            periods: opts.periods,
            repo: opts.repo,
        }),
        perPeriod: aggregatePerPeriod(db, {
            periods: opts.periods,
            repo: opts.repo,
        }),
        perDev: aggregatePerDev(db, {
            periods: opts.periods,
            timezone: opts.timezone,
            repo: opts.repo,
        }),
        sizeTrend: aggregateSizeTrend(db, { repo: opts.repo }),
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
