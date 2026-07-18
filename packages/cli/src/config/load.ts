import type { z } from "zod";
import { configSchema, type SpanicalConfig } from "./schema";

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
