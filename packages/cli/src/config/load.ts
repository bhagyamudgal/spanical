import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { tryCatch } from "@spanical/utils";
import type { z } from "zod";
import { configSchema, type SpanicalConfig } from "./schema";

const CONFIG_FILENAME = "spanical.config.ts";

const CONFIG_ERROR_CODES = {
    NOT_FOUND: "CONFIG_NOT_FOUND",
    INVALID: "CONFIG_INVALID",
    IMPORT_FAILED: "CONFIG_IMPORT_FAILED",
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

function resolveConfigPath(options: {
    configPath?: string;
    cwd?: string;
}): string {
    const cwd = options.cwd ?? process.cwd();
    if (options.configPath) {
        return isAbsolute(options.configPath)
            ? options.configPath
            : resolve(cwd, options.configPath);
    }
    return resolve(cwd, CONFIG_FILENAME);
}

export async function loadConfig(
    options: { configPath?: string; cwd?: string } = {}
): Promise<SpanicalConfig> {
    const path = resolveConfigPath(options);
    if (!existsSync(path)) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.NOT_FOUND,
            `No spanical config found at ${path}. Create a spanical.config.ts or pass --config <path>.`
        );
    }
    const { data: imported, error } = await tryCatch(import(path));
    if (error) {
        throw new ConfigError(
            CONFIG_ERROR_CODES.IMPORT_FAILED,
            `Failed to load config at ${path}: ${error.message}`,
            { cause: error }
        );
    }
    return parseConfig(imported.default);
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
