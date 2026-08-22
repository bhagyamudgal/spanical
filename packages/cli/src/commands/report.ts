import { command, string } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import {
    aggregateAll,
    aggregateComplexityAttribution,
    aggregateHotspots,
    aggregateOwnership,
    aggregatePerDev,
    aggregateTimeline,
    reposWithoutWindowEndSnapshot,
} from "../aggregate";
import type {
    ComplexityAttribution,
    DevPeriodRollup,
} from "../aggregate/types";
import type { CacheDatabase } from "../cache/open";
import { openCache } from "../cache/open";
import { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import {
    ensureBaselineSnapshots,
    ensureExtracted,
    ensureMonthlySnapshots,
    ensureOwnership,
    ensureRework,
    resolveWindowStart,
} from "../pipeline/prepare";
import { writeRendered } from "../render";
import {
    buildReportArtifact,
    type PerRepoInsight,
    type ReportTickets,
} from "../report/artifact";
import { buildDashboardHtml } from "../report/dashboard";
import { defaultReportPath } from "../report/filename";
import { formatHeadline } from "../report/headline";
import {
    collectTicketInsight,
    hasTicketInsightActivity,
    refreshTicketCache,
    type TicketRefresh,
} from "../report/ticket-layer";
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
    repos: string[]
): DevPeriodRollup[] {
    if (start === null) {
        return [];
    }
    return aggregatePerDev(db, {
        periods: [{ label: run.window.label, start, end: run.window.end }],
        timezone: run.tz,
        repos,
        reworkWindowDays: run.config.reworkWindowDays,
    });
}

function buildReportTickets(
    db: CacheDatabase,
    run: ResolvedRun,
    refresh: TicketRefresh | null,
    repos: string[]
): ReportTickets | null {
    if (refresh === null) {
        return null;
    }
    const combined = collectTicketInsight(db, run, refresh, repos);
    if (refresh.failure === null && !hasTicketInsightActivity(combined)) {
        return null;
    }
    return {
        combined,
        byRepo: new Map(
            repos.map((repo) => [
                repo,
                collectTicketInsight(db, run, refresh, [repo]),
            ])
        ),
        failure: refresh.failure,
    };
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
    await ensureExtracted(run, configPath, now);
    const { config } = run;
    const handle = openCache({ configPath });
    try {
        const { db } = handle;
        const {
            months: sizeMonths,
            snapshots: sizeSnapshots,
            windowEndShas,
        } = await ensureMonthlySnapshots(db, run);
        await ensureOwnership(db, run, config);
        const rework = await ensureRework(db, run, config);
        if (rework.unknownEmails.length > 0) {
            process.stderr.write(
                `warning: ${rework.unknownEmails.length} author email(s) not in config: ${rework.unknownEmails.join(", ")}\n`
            );
        }
        const baselineShas = await ensureBaselineSnapshots(db, run);

        const repoNames = run.repos.map((repo) => repo.name);
        const { minFileLines, busFactorThreshold } = config.hotspot;
        const start = resolveWindowStart(db, run);
        const ticketRefresh = await refreshTicketCache(db, run, { now });

        const full = aggregateAll(db, {
            window: run.window,
            timezone: run.tz,
            repos: repoNames,
            sizeMonths,
            sizeSnapshots,
        });
        const contributors = computeContributors(db, run, start, repoNames);
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
                const repoContributors = computeContributors(db, run, start, [
                    repo,
                ]);
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
            minFileLines,
            busFactorThreshold,
            windowEndShas,
            tickets: buildReportTickets(db, run, ticketRefresh, repoNames),
            incompleteReworkRepos: rework.incompleteRepos,
            run,
        });
        const isHtml = run.format === "html";
        const artifactPath =
            run.out ??
            defaultReportPath(
                run.window,
                run.tz,
                undefined,
                isHtml ? "html" : "md"
            );
        writeRendered(
            isHtml
                ? buildDashboardHtml({
                      windowLabel: run.window.label,
                      summary: full.combined.summary,
                      perPeriod: full.combined.perPeriod,
                      perDev: full.combined.perDev,
                      sizeTrend: full.combined.sizeTrend,
                      hotspots,
                  })
                : artifact,
            artifactPath
        );
        const headline = formatHeadline({
            summary: full.combined.summary,
            granularity: run.window.granularity,
            hotspots,
            ownership,
            minFileLines,
            unmeasuredRepos: reposWithoutWindowEndSnapshot(
                repoNames,
                windowEndShas
            ),
            repoCount: repoNames.length,
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
    options: {
        ...globalFlags,
        format: string()
            .enum("table", "json", "md", "html")
            .desc("Output format"),
    },
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
