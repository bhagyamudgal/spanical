import { basename, resolve } from "node:path";
import type { TypeOf } from "@drizzle-team/brocli";
import { resolveConfig } from "../config/load";
import { isValidTimeZone, type SpanicalConfig } from "../config/schema";
import {
    resolveWindow,
    WindowError,
    WINDOW_ERROR_CODES,
    type ResolvedWindow,
} from "../window";
import type { globalFlags } from "./global-flags";

type RunFlags = TypeOf<typeof globalFlags>;

const DEFAULT_FORMAT = "table";

export type ResolvedRun = {
    repos: SpanicalConfig["repos"];
    config: SpanicalConfig;
    tz: string;
    exclude: string[];
    by: "dev" | "file" | "dir" | "language" | null;
    format: "table" | "json" | "md";
    out: string | null;
    cache: boolean;
    window: ResolvedWindow;
};

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function parseRepoFlag(value: string, cwd: string): ResolvedRun["repos"] {
    const repos = splitList(value).map((path) => ({
        name: basename(resolve(cwd, path)),
        path,
    }));

    // A config file's repos go through zod, which rejects an empty name; --repo
    // has to reject it here or the same path would be valid with a config file
    // present and invalid without one.
    const unnameable = repos.filter((repo) => repo.name.length === 0);
    if (unnameable.length > 0) {
        throw new WindowError(
            WINDOW_ERROR_CODES.UNNAMEABLE_REPO_PATH,
            `Cannot derive a repo name from: ${unnameable.map((repo) => repo.path).join(", ")}. Each --repo path must end in a directory name.`
        );
    }

    const repoNames = repos.map((repo) => repo.name);
    if (new Set(repoNames).size !== repoNames.length) {
        const duplicates = [
            ...new Set(
                repoNames.filter(
                    (name, index) => repoNames.indexOf(name) !== index
                )
            ),
        ];
        throw new WindowError(
            WINDOW_ERROR_CODES.DUPLICATE_REPO_NAMES,
            `Duplicate repo name(s): ${duplicates.join(", ")}. Each --repo path must end in a distinct final segment.`
        );
    }

    return repos;
}

export async function resolveRunConfig(input: {
    flags: Partial<RunFlags>;
    cwd?: string;
    now: Date;
}): Promise<ResolvedRun> {
    const { flags } = input;
    const flagRepos =
        flags.repo !== undefined && flags.repo.length > 0
            ? parseRepoFlag(flags.repo, input.cwd ?? process.cwd())
            : undefined;
    const config = await resolveConfig({
        configPath: flags.config,
        cwd: input.cwd,
        repos: flagRepos,
    });

    const tz = flags.tz ?? config.timezone;
    if (!isValidTimeZone(tz)) {
        throw new WindowError(
            WINDOW_ERROR_CODES.INVALID_TIMEZONE,
            `Invalid timezone "${tz}". Use a valid IANA zone like "UTC" or "America/New_York".`
        );
    }

    const exclude =
        flags.exclude !== undefined && flags.exclude.length > 0
            ? splitList(flags.exclude)
            : config.exclude;
    const effectiveConfig: SpanicalConfig = {
        ...config,
        exclude,
    };

    return {
        repos: effectiveConfig.repos,
        config: effectiveConfig,
        tz,
        exclude: effectiveConfig.exclude,
        by: flags.by ?? null,
        format: flags.format ?? DEFAULT_FORMAT,
        out: flags.out ?? null,
        cache: !flags["no-cache"],
        window: resolveWindow({
            flags,
            timezone: tz,
            now: input.now,
            period: flags.period,
        }),
    };
}
