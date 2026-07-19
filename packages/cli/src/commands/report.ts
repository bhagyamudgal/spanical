import { command } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import {
    aggregateAll,
    aggregateComplexityAttribution,
    aggregateHotspots,
    aggregateOwnership,
    aggregatePerDev,
    aggregateTimeline,
} from "../aggregate";
import type { ComplexityAttribution, DevPeriodRollup } from "../aggregate/types";
import type { CacheDatabase } from "../cache/open";
import { openCache } from "../cache/open";
import { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import { loadConfig } from "../config/load";
import {
    ensureBaselineSnapshots,
    ensureExtracted,
    ensureMonthlySnapshots,
    ensureOwnership,
    ensureWindowEndSnapshot,
    resolveWindowStart,
} from "../pipeline/prepare";
import { writeRendered } from "../render";
import { buildReportArtifact, type PerRepoInsight } from "../report/artifact";
import { defaultReportPath } from "../report/filename";
import { formatHeadline } from "../report/headline";
import type { Granularity } from "../window";

const GRANULARITY_ADVERB: Record<Granularity, string> = {
    week: "weekly",
    month: "monthly",
    quarter: "quarterly",
};

export function formatRunHeader(run: ResolvedRun): string {
    const repoCount = run.repos.length;
    const repoLabel = `${repoCount} ${repoCount === 1 ? "repo" : "repos"}`;
    return `${run.window.label} · ${GRANULARITY_ADVERB[run.window.granularity]} · ${repoLabel} · ${run.tz}`;
}

type ComplexityScope = {
    run: ResolvedRun;
    start: Date | null;
    repos: string[];
    minFileLines: number;
    busFactorThreshold: number;
    windowEndShas: Map<string, string>;
    baselineShas: Map<string, string>;
    contributors: DevPeriodRollup[];
};

function computeContributors(
    db: CacheDatabase,
    run: ResolvedRun,
    start: Date | null,
    repo?: string
): DevPeriodRollup[] {
    if (start === null) {
        return [];
    }
    return aggregatePerDev(db, {
        periods: [{ label: run.window.label, start, end: run.window.end }],
        timezone: run.tz,
        repo,
    });
}

function computeComplexity(
    db: CacheDatabase,
    scope: ComplexityScope
): ComplexityAttribution {
    if (scope.start === null) {
        return { devs: [], unattributed: 0 };
    }
    return aggregateComplexityAttribution(db, {
        window: scope.run.window,
        windowStart: scope.start,
        repos: scope.repos,
        timezone: scope.run.tz,
        minFileLines: scope.minFileLines,
        busFactorThreshold: scope.busFactorThreshold,
        windowEndShas: scope.windowEndShas,
        baselineShas: scope.baselineShas,
        perDev: scope.contributors,
    });
}

export async function runReport(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<{ terminal: string; artifactPath: string }> {
    await ensureExtracted(configPath, run.cache, now);
    const config = await loadConfig({ configPath });
    const handle = openCache({ configPath });
    try {
        const { db } = handle;
        await ensureMonthlySnapshots(db, run);
        await ensureOwnership(db, run, config);
        const windowEndShas = await ensureWindowEndSnapshot(db, run);
        const baselineShas = await ensureBaselineSnapshots(db, run);

        const repoNames = run.repos.map((repo) => repo.name);
        const { minFileLines, busFactorThreshold } = config.hotspot;
        const start = resolveWindowStart(db, run);

        const full = aggregateAll(db, {
            window: run.window,
            timezone: run.tz,
            repos: repoNames,
        });
        const contributors = computeContributors(db, run, start);
        const complexity = computeComplexity(db, {
            run,
            start,
            repos: repoNames,
            minFileLines,
            busFactorThreshold,
            windowEndShas,
            baselineShas,
            contributors,
        });
        const hotspots = aggregateHotspots(db, {
            window: run.window,
            repos: repoNames,
            minFileLines,
            busFactorThreshold,
            windowEndShas,
        });
        const ownership = aggregateOwnership(db, {
            repos: repoNames,
            busFactorThreshold,
        });
        const timeline = await aggregateTimeline(db, {
            window: run.window,
            repos: run.repos,
        });

        const pathByRepo = new Map(
            run.repos.map((repo) => [repo.name, repo.path])
        );
        const perRepoInsights: PerRepoInsight[] = await Promise.all(
            full.perRepo.map(async ({ repo, aggregation }) => {
                const repoPath = pathByRepo.get(repo);
                const repoContributors = computeContributors(
                    db,
                    run,
                    start,
                    repo
                );
                return {
                    repo,
                    aggregation,
                    contributors: repoContributors,
                    hotspots: aggregateHotspots(db, {
                        window: run.window,
                        repos: [repo],
                        minFileLines,
                        busFactorThreshold,
                        windowEndShas,
                    }),
                    ownership: aggregateOwnership(db, {
                        repos: [repo],
                        busFactorThreshold,
                    }),
                    complexity: computeComplexity(db, {
                        run,
                        start,
                        repos: [repo],
                        minFileLines,
                        busFactorThreshold,
                        windowEndShas,
                        baselineShas,
                        contributors: repoContributors,
                    }),
                    timeline:
                        repoPath === undefined
                            ? []
                            : await aggregateTimeline(db, {
                                  window: run.window,
                                  repos: [{ name: repo, path: repoPath }],
                              }),
                };
            })
        );

        const artifact = buildReportArtifact({
            full,
            contributors,
            hotspots,
            ownership,
            complexity,
            timeline,
            perRepoInsights,
            busFactorThreshold,
            run,
        });
        const artifactPath = run.out ?? defaultReportPath(run.window, run.tz);
        writeRendered(artifact, artifactPath);
        const headline = formatHeadline({
            summary: full.combined.summary,
            granularity: run.window.granularity,
            hotspots,
            ownership,
            busFactorThreshold,
        });
        const terminal = `${formatRunHeader(run)}\n\n${headline}\n\nFull report -> ${artifactPath}`;
        return { terminal, artifactPath };
    } finally {
        handle.sqlite.close();
    }
}

export const reportCommand = command({
    name: "report",
    desc: "Generate an engineering insights report",
    options: { ...globalFlags },
    handler: async (flags) => {
        const now = new Date();
        const { data: run, error: resolveError } = await tryCatch(
            resolveRunConfig({ flags, now })
        );
        if (resolveError) {
            process.stderr.write(`${resolveError.message}\n`);
            process.exit(1);
        }
        const { data: result, error: reportError } = await tryCatch(
            runReport(run, flags.config, now)
        );
        if (reportError) {
            process.stderr.write(`${reportError.message}\n`);
            process.exit(1);
        }
        console.log(result.terminal);
    },
});
