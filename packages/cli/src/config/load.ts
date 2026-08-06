import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tryCatch } from "@spanical/utils";
import type { z } from "zod";
import { assertGitAvailable, resolveGitRoot } from "../extract/git";
import { configSchema, type SpanicalConfig } from "./schema";

const CONFIG_FILENAME = "spanical.config.ts";
const GIT_DIR_NAME = ".git";

const CONFIG_ERROR_CODES = {
    NOT_FOUND: "CONFIG_NOT_FOUND",
    INVALID: "CONFIG_INVALID",
    IMPORT_FAILED: "CONFIG_IMPORT_FAILED",
    NO_GIT_REPO: "CONFIG_NO_GIT_REPO",
} as const;

type ConfigErrorCode =
    (typeof CONFIG_ERROR_CODES)[keyof typeof CONFIG_ERROR_CODES];

export class ConfigError extends Error {
    readonly code: ConfigErrorCode;
    constructor(
        code: ConfigErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "ConfigError";
        this.code = code;
    }
}

function formatIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path =
                issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `  - ${path}: ${issue.message}`;
        })
        .join("\n");
}

export function parseConfig(raw: unknown): SpanicalConfig {
    const result = configSchema.safeParse(raw);
    if (!result.success) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.INVALID,
            `Invalid spanical config:\n${formatIssues(result.error)}`,
            { cause: result.error }
        );
    }
    return result.data;
}

// lstat, not existsSync: a dangling symlink at the config path is intent to have
// a config there, and must reach loadConfig instead of falling back to defaults.
function isPathPresent(path: string): boolean {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

// Walks up from cwd so a config at the repo root serves its subdirectories. When
// no config exists the git root's (absent) config path is still returned, which
// keeps the cache next to the repo instead of scattering one per subdirectory.
function discoverConfigPath(cwd: string): string {
    let current = resolve(cwd);
    for (;;) {
        const candidate = join(current, CONFIG_FILENAME);
        if (
            isPathPresent(candidate) ||
            isPathPresent(join(current, GIT_DIR_NAME))
        ) {
            return candidate;
        }
        const parent = dirname(current);
        if (parent === current) {
            return join(resolve(cwd), CONFIG_FILENAME);
        }
        current = parent;
    }
}

export function resolveConfigPath(options: {
    configPath?: string;
    cwd?: string;
}): string {
    const cwd = options.cwd ?? process.cwd();
    if (options.configPath) {
        return isAbsolute(options.configPath)
            ? options.configPath
            : resolve(cwd, options.configPath);
    }
    return discoverConfigPath(cwd);
}

export async function loadConfig(
    options: { configPath?: string; cwd?: string } = {}
): Promise<SpanicalConfig> {
    const path = resolveConfigPath(options);
    if (!existsSync(path)) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.NOT_FOUND,
            `No spanical config found at ${path}. Create a spanical.config.ts to get started.`
        );
    }
    const { data: imported, error } = await tryCatch<{ default: unknown }>(
        import(path)
    );
    if (error) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.IMPORT_FAILED,
            `Failed to load config at ${path}: ${error.message}`,
            { cause: error }
        );
    }
    if (imported.default === undefined) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.INVALID,
            `Config at ${path} has no default export. Use "export default defineConfig({ ... })".`
        );
    }
    return parseConfig(imported.default);
}

type RepoList = SpanicalConfig["repos"];

async function reposFromWorkingDirectory(cwd: string): Promise<RepoList> {
    assertGitAvailable();
    const root = await resolveGitRoot(cwd);
    if (root === null) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.NO_GIT_REPO,
            `No ${CONFIG_FILENAME} found and ${cwd} is not inside a git repository. Run spanical from a git repository, pass --repo <path>, or create a ${CONFIG_FILENAME}.`
        );
    }
    return [{ name: basename(root), path: root }];
}

export async function resolveConfig(
    options: { configPath?: string; cwd?: string; repos?: RepoList } = {}
): Promise<SpanicalConfig> {
    const hasConfigFile =
        Boolean(options.configPath) ||
        isPathPresent(resolveConfigPath(options));
    if (hasConfigFile) {
        const config = await loadConfig(options);
        return options.repos === undefined
            ? config
            : { ...config, repos: options.repos };
    }
    const cwd = options.cwd ?? process.cwd();
    const repos = options.repos ?? (await reposFromWorkingDirectory(cwd));
    process.stderr.write(
        `note: no ${CONFIG_FILENAME} found; analysing ${repos.map((repo) => repo.path).join(", ")} with default settings.\n`
    );
    return parseConfig({ repos });
}

export async function loadConfigOrExit(
    options: { configPath?: string; cwd?: string } = {}
): Promise<SpanicalConfig> {
    const { data, error } = await tryCatch(loadConfig(options));
    if (error) {
        process.stderr.write(`${error.message}\n`);
        process.exit(1);
    }
    return data;
}
