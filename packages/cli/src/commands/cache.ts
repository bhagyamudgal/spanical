import { command, type TypeOf } from "@drizzle-team/brocli";
import { tryCatch, tryCatchSync } from "@spanical/utils";
import { globalFlags } from "../cli/global-flags";
import {
    clearCache,
    formatCacheStats,
    gatherCacheStats,
    openCache,
    rebuildCache,
    resolveCachePath,
    type CacheHandle,
} from "../cache";
import { extractAll, type ExtractionResult } from "../extract";

type CacheFlags = TypeOf<typeof globalFlags>;

function openOrExit(flags: CacheFlags): CacheHandle {
    const { data: handle, error } = tryCatchSync(() =>
        openCache({ configPath: flags.config })
    );
    if (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
    return handle;
}

function runCacheStats(flags: CacheFlags): void {
    const handle = openOrExit(flags);
    const stats = gatherCacheStats(handle.db, handle.path);
    handle.sqlite.close();
    console.log(formatCacheStats(stats));
}

function formatExtractionSummary(result: ExtractionResult): string {
    return result.repos
        .map((repo) =>
            repo.status === "skipped"
                ? `${repo.repo}: skipped (unchanged)`
                : `${repo.repo}: extracted (${repo.commitCount} commit${repo.commitCount === 1 ? "" : "s"}, ${repo.fileChangeCount} file change${repo.fileChangeCount === 1 ? "" : "s"})`
        )
        .join("\n");
}

async function runCacheRebuild(flags: CacheFlags): Promise<void> {
    const handle = openOrExit(flags);
    rebuildCache(handle.sqlite);
    handle.sqlite.close();
    console.log(`Cache rebuilt at ${handle.path}`);

    const { data: result, error } = await tryCatch(
        extractAll({ configPath: flags.config, noCache: true, now: new Date() })
    );
    if (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
    console.log(formatExtractionSummary(result));
    if (result.unknownEmails.length > 0) {
        process.stderr.write(
            `warning: ${result.unknownEmails.length} author email(s) not in config: ${result.unknownEmails.join(", ")}\n`
        );
    }
}

function runCacheClear(flags: CacheFlags): void {
    const path = resolveCachePath({ configPath: flags.config });
    clearCache(path);
    console.log(`Cache cleared at ${path}`);
}

const statsSubcommand = command({
    name: "stats",
    desc: "Show cache row counts, size, and last extraction per repo",
    options: { ...globalFlags },
    handler: runCacheStats,
});

const rebuildSubcommand = command({
    name: "rebuild",
    desc: "Drop the cache and re-extract all repos from git",
    options: { ...globalFlags },
    handler: runCacheRebuild,
});

const clearSubcommand = command({
    name: "clear",
    desc: "Delete the cache database and its sidecar files",
    options: { ...globalFlags },
    handler: runCacheClear,
});

export const cacheCommand = command({
    name: "cache",
    desc: "Inspect and manage the local SQLite cache",
    options: { ...globalFlags },
    handler: runCacheStats,
    subcommands: [statsSubcommand, rebuildSubcommand, clearSubcommand],
});
