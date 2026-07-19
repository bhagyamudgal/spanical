import { command } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import { aggregateAll, aggregatePerDev } from "../aggregate";
import { openCache } from "../cache/open";
import { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import {
    ensureExtracted,
    ensureMonthlySnapshots,
    resolveWindowStart,
} from "../pipeline/prepare";
import { writeRendered } from "../render";
import { buildReportArtifact } from "../report/artifact";
import { defaultReportPath } from "../report/filename";
import { formatSummaryBlock } from "../report/summary-block";
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

export async function runReport(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<{ terminal: string; artifactPath: string }> {
    await ensureExtracted(configPath, run.cache, now);
    const handle = openCache({ configPath });
    try {
        await ensureMonthlySnapshots(handle.db, run);
        const full = aggregateAll(handle.db, {
            window: run.window,
            timezone: run.tz,
            repos: run.repos.map((repo) => repo.name),
        });
        const start = resolveWindowStart(handle.db, run);
        const contributors =
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
        const artifact = buildReportArtifact({ full, contributors, run });
        const artifactPath = run.out ?? defaultReportPath(run.window, run.tz);
        writeRendered(artifact, artifactPath);
        const terminal = `${formatRunHeader(run)}\n\n${formatSummaryBlock(full.combined.summary, run.window.granularity)}\n\nFull report -> ${artifactPath}`;
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
