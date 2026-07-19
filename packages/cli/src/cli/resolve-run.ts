import { basename } from "node:path";
import type { TypeOf } from "@drizzle-team/brocli";
import { loadConfig } from "../config/load";
import { isValidTimeZone } from "../config/schema";
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
    repos: { name: string; path: string; branch?: string }[];
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

export async function resolveRunConfig(input: {
    flags: Partial<RunFlags>;
    cwd?: string;
    now: Date;
}): Promise<ResolvedRun> {
    const { flags } = input;
    const config = await loadConfig({
        configPath: flags.config,
        cwd: input.cwd,
    });

    const repos =
        flags.repo !== undefined && flags.repo.length > 0
            ? splitList(flags.repo).map((path) => ({
                  name: basename(path),
                  path,
              }))
            : config.repos;

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

    return {
        repos,
        tz,
        exclude,
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
