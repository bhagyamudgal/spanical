export const EXTRACT_ERROR_CODES = {
    GIT_NOT_FOUND: "EXTRACT_GIT_NOT_FOUND",
    BRANCH_UNRESOLVED: "EXTRACT_BRANCH_UNRESOLVED",
    GIT_COMMAND_FAILED: "EXTRACT_GIT_COMMAND_FAILED",
    SHALLOW_HISTORY: "EXTRACT_SHALLOW_HISTORY",
} as const;

type ExtractErrorCode =
    (typeof EXTRACT_ERROR_CODES)[keyof typeof EXTRACT_ERROR_CODES];

export class ExtractError extends Error {
    readonly code: ExtractErrorCode;
    constructor(
        code: ExtractErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "ExtractError";
        this.code = code;
    }
}
