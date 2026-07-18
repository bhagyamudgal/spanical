import { command } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import type { Granularity } from "../window";

const GRANULARITY_ADVERB: Record<Granularity, string> = {
    week: "weekly",
    month: "monthly",
    quarter: "quarterly",
};

const PENDING_BODY_NOTICE = "(report body: not yet implemented)";

export function formatRunHeader(run: ResolvedRun): string {
    const repoCount = run.repos.length;
    const repoLabel = `${repoCount} ${repoCount === 1 ? "repo" : "repos"}`;
    return `${run.window.label} · ${GRANULARITY_ADVERB[run.window.granularity]} · ${repoLabel} · ${run.tz}`;
}

export const reportCommand = command({
    name: "report",
    desc: "Generate an engineering insights report",
    options: { ...globalFlags },
    handler: async (flags) => {
        const { data: run, error } = await tryCatch(
            resolveRunConfig({ flags, now: new Date() })
        );
        if (error) {
            process.stderr.write(`${error.message}\n`);
            process.exit(1);
        }
        console.log(formatRunHeader(run));
        console.log(PENDING_BODY_NOTICE);
    },
});
