export const UPDATE_ERROR_CODES = {
    CHECK_FAILED: "UPDATE_CHECK_FAILED",
    DOWNLOAD_FAILED: "UPDATE_DOWNLOAD_FAILED",
} as const;

type UpdateErrorCode =
    (typeof UPDATE_ERROR_CODES)[keyof typeof UPDATE_ERROR_CODES];

export class UpdateError extends Error {
    readonly code: UpdateErrorCode;
    constructor(
        code: UpdateErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "UpdateError";
        this.code = code;
    }
}

// Node errno codes live on Error subclasses that TS's lib types don't model, so the
// property access needs the assertion.
export function errorCode(error: unknown): string | null {
    if (!(error instanceof Error)) return null;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
}
