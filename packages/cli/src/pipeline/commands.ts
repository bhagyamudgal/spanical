import {
    aggregateOwnership,
    aggregatePerDev,
    aggregatePerPeriod,
    aggregateSizeTrend,
} from "../aggregate";
import { openCache } from "../cache/open";
import type { ResolvedRun } from "../cli/resolve-run";
import { loadConfig } from "../config/load";
import {
    churnPeriodTable,
    devTable,
    renderData,
    renderOwnershipReport,
    sizeTable,
} from "../render";
import {
    ensureExtracted,
    ensureMonthlySnapshots,
    ensureOwnership,
    resolveWindowStart,
} from "./prepare";

export async function runChurn(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(configPath, run.cache, now);
    const handle = openCache({ configPath });
    try {
        if (run.by === "dev") {
            const rows = aggregatePerDev(handle.db, {
                periods: run.window.periods,
                timezone: run.tz,
            });
            return renderData(
                run.format,
                devTable(rows, { includePeriod: true }),
                rows
            );
        }
        const rows = aggregatePerPeriod(handle.db, {
            periods: run.window.periods,
        });
        return renderData(run.format, churnPeriodTable(rows), rows);
    } finally {
        handle.sqlite.close();
    }
}

export async function runContributors(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(configPath, run.cache, now);
    const handle = openCache({ configPath });
    try {
        const start = resolveWindowStart(handle.db, run);
        const rows =
            start === null
                ? []
                : aggregatePerDev(handle.db, {
                      periods: [
                          {
                              label: run.window.label,
                              start,
                              end: run.window.end,
                          },
                      ],
                      timezone: run.tz,
                  });
        return renderData(
            run.format,
            devTable(rows, { includePeriod: false }),
            rows
        );
    } finally {
        handle.sqlite.close();
    }
}

export async function runSize(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(configPath, run.cache, now);
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        const rows = aggregateSizeTrend(handle.db, {});
        return renderData(run.format, sizeTable(rows), rows);
    } finally {
        handle.sqlite.close();
    }
}

export async function runOwnership(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    const [config] = await Promise.all([
        loadConfig({ configPath }),
        ensureExtracted(configPath, run.cache, now),
    ]);
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        await ensureOwnership(handle.db, run, config);
        const result = aggregateOwnership(handle.db, {
            repos: run.repos.map((repo) => repo.name),
            busFactorThreshold: config.hotspot.busFactorThreshold,
        });
        return renderOwnershipReport(run.format, result);
    } finally {
        handle.sqlite.close();
    }
}
