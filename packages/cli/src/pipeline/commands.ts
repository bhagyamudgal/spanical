import {
    aggregateComplexityAttribution,
    aggregateHotspots,
    aggregateOwnership,
    aggregatePerDev,
    aggregatePerPeriod,
    aggregateSizeTrend,
    aggregateTickets,
    aggregateTimeline,
} from "../aggregate";
import { openCache } from "../cache/open";
import type { ResolvedRun } from "../cli/resolve-run";
import {
    formatUnmappedLoginsWarning,
    requireTicketsConfig,
    resolveGithubToken,
    syncTickets,
} from "../github";
import {
    churnPeriodTable,
    devTable,
    hotspotsTable,
    renderContributorsReport,
    renderData,
    renderOwnershipReport,
    renderTicketsReport,
    sizeTable,
    timelineTable,
} from "../render";
import {
    ensureBaselineSnapshots,
    ensureExtracted,
    ensureMonthlySnapshots,
    ensureOwnership,
    ensureWindowEndSnapshot,
    resolveWindowStart,
} from "./prepare";

function repoNames(run: ResolvedRun): string[] {
    return run.repos.map((repo) => repo.name);
}

export async function runChurn(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(run, configPath, now);
    const handle = openCache({ configPath });
    const repos = repoNames(run);
    try {
        if (run.by === "dev") {
            const rows = aggregatePerDev(handle.db, {
                periods: run.window.periods,
                timezone: run.tz,
                repos,
            });
            return renderData(
                run.format,
                devTable(rows, { includePeriod: true }),
                rows
            );
        }
        const rows = aggregatePerPeriod(handle.db, {
            periods: run.window.periods,
            repos,
        });
        return renderData(run.format, churnPeriodTable(rows), rows);
    } finally {
        handle.sqlite.close();
    }
}

export async function runTimeline(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(run, configPath, now);
    const handle = openCache({ configPath });
    try {
        const rows = await aggregateTimeline(handle.db, {
            window: run.window,
            repos: run.repos.map((repo) => ({
                name: repo.name,
                path: repo.path,
            })),
        });
        return renderData(run.format, timelineTable(rows), rows);
    } finally {
        handle.sqlite.close();
    }
}

export async function runContributors(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(run, configPath, now);
    const { config } = run;
    const handle = openCache({ configPath });
    const repos = repoNames(run);
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
            periods: [{ label: run.window.label, start, end: run.window.end }],
            timezone: run.tz,
            repos,
        });
        const attribution = aggregateComplexityAttribution(handle.db, {
            window: run.window,
            windowStart: start,
            repos,
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
    await ensureExtracted(run, configPath, now);
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        const rows = aggregateSizeTrend(handle.db, { repos: repoNames(run) });
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
    await ensureExtracted(run, configPath, now);
    const { config } = run;
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        await ensureOwnership(handle.db, run, config);
        const result = aggregateOwnership(handle.db, {
            repos: repoNames(run),
            busFactorThreshold: config.hotspot.busFactorThreshold,
        });
        return renderOwnershipReport(run.format, result);
    } finally {
        handle.sqlite.close();
    }
}

// The token is resolved before anything else so a missing credential costs no
// extraction, and the tickets config before that so an unconfigured repo is
// told what it is actually missing.
export async function runTickets(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    const ticketsConfig = requireTicketsConfig(run.config);
    const token = resolveGithubToken();
    await ensureExtracted(run, configPath, now);
    const handle = openCache({ configPath });
    try {
        const sync = await syncTickets(handle.db, run.config, {
            token,
            now,
            isCacheEnabled: run.cache,
        });
        if (sync.unmappedLogins.length > 0) {
            process.stderr.write(
                `${formatUnmappedLoginsWarning(sync.unmappedLogins)}\n`
            );
        }
        const result = aggregateTickets(handle.db, {
            window: run.window,
            repos: repoNames(run),
            attribution: ticketsConfig.attribution,
            timezone: run.tz,
            includeIssues: ticketsConfig.github.includeIssues,
        });
        return renderTicketsReport(run.format, result, {
            window: run.window.label,
            repos: repoNames(run),
        });
    } finally {
        handle.sqlite.close();
    }
}

export async function runHotspots(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<string> {
    await ensureExtracted(run, configPath, now);
    const { config } = run;
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        await ensureOwnership(handle.db, run, config);
        const windowEndShas = await ensureWindowEndSnapshot(handle.db, run);
        const rows = aggregateHotspots(handle.db, {
            window: run.window,
            repos: repoNames(run),
            minFileLines: config.hotspot.minFileLines,
            busFactorThreshold: config.hotspot.busFactorThreshold,
            windowEndShas,
        });
        return renderData(run.format, hotspotsTable(rows), rows);
    } finally {
        handle.sqlite.close();
    }
}
