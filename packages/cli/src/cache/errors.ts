export const CACHE_ERROR_CODES = {
    OPEN_FAILED: "CACHE_OPEN_FAILED",
} as const;

type CacheErrorCode =
    (typeof CACHE_ERROR_CODES)[keyof typeof CACHE_ERROR_CODES];

export class CacheError extends Error {
    readonly code: CacheErrorCode;
    constructor(
        code: CacheErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "CacheError";
        this.code = code;
    }
}
