export const SCC_ERROR_CODES = {
    UNSUPPORTED_PLATFORM: "SCC_UNSUPPORTED_PLATFORM",
    DOWNLOAD_FAILED: "SCC_DOWNLOAD_FAILED",
    CHECKSUM_MISMATCH: "SCC_CHECKSUM_MISMATCH",
    SCC_RUN_FAILED: "SCC_RUN_FAILED",
    SHALLOW_HISTORY: "SCC_SHALLOW_HISTORY",
    WORKTREE_FAILED: "SCC_WORKTREE_FAILED",
} as const;

type SccErrorCode = (typeof SCC_ERROR_CODES)[keyof typeof SCC_ERROR_CODES];

export class SccError extends Error {
    readonly code: SccErrorCode;
    constructor(
        code: SccErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "SccError";
        this.code = code;
    }
}
