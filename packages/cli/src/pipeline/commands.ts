import {
    aggregateComplexityAttribution,
    aggregateHotspots,
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
    hotspotsTable,
    renderContributorsReport,
    renderData,
    renderOwnershipReport,
    sizeTable,
} from "../render";
import {
    ensureBaselineSnapshots,
    ensureExtracted,
    ensureMonthlySnapshots,
    ensureOwnership,
    ensureWindowEndSnapshot,
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
    const config = await loadConfig({ configPath });
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        await ensureOwnership(handle.db, run, config);
        const windowEndShas = await ensureWindowEndSnapshot(handle.db, run);
        const baselineShas = await ensureBaselineSnapshots(handle.db, run);
        const start = resolveWindowStart(handle.db, run);
        if (start === null) {
            return renderContributorsReport(run.format, {
                contributors: [],
                complexity: [],
                unattributedComplexity: 0,
            });
        }
        const contributors = aggregatePerDev(handle.db, {
            periods: [
                { label: run.window.label, start, end: run.window.end },
            ],
            timezone: run.tz,
        });
        const attribution = aggregateComplexityAttribution(handle.db, {
            window: run.window,
            windowStart: start,
            repos: run.repos.map((repo) => repo.name),
            timezone: run.tz,
            minFileLines: config.hotspot.minFileLines,
            busFactorThreshold: config.hotspot.busFactorThreshold,
            windowEndShas,
            baselineShas,
            perDev: contributors,
        });
        return renderContributorsReport(run.format, {
            contributors,
            complexity: attribution.devs,
            unattributedComplexity: attribution.unattributed,
        });
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

export async function runHotspots(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(configPath, run.cache, now);
    const config = await loadConfig({ configPath });
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        await ensureOwnership(handle.db, run, config);
        const windowEndShas = await ensureWindowEndSnapshot(handle.db, run);
        const rows = aggregateHotspots(handle.db, {
            window: run.window,
            repos: run.repos.map((repo) => repo.name),
            minFileLines: config.hotspot.minFileLines,
            busFactorThreshold: config.hotspot.busFactorThreshold,
            windowEndShas,
        });
        return renderData(run.format, hotspotsTable(rows), rows);
    } finally {
        handle.sqlite.close();
    }
}
