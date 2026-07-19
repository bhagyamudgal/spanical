import { command } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import { writeRendered } from "../render";

type InsightRunner = (
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
) => Promise<string>;

export function createInsightCommand(spec: {
    name: string;
    desc: string;
    run: InsightRunner;
}) {
    return command({
        name: spec.name,
        desc: spec.desc,
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
            const { data: output, error: renderError } = await tryCatch(
                spec.run(run, flags.config, now)
            );
            if (renderError) {
                process.stderr.write(`${renderError.message}\n`);
                process.exit(1);
            }
            writeRendered(output, run.out);
        },
    });
}
