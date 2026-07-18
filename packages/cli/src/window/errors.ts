export const WINDOW_ERROR_CODES = {
    CONFLICTING_SELECTORS: "WINDOW_CONFLICTING_SELECTORS",
    INVALID_LAST_FORMAT: "WINDOW_INVALID_LAST_FORMAT",
    INVALID_THIS_UNIT: "WINDOW_INVALID_THIS_UNIT",
    INVALID_TIMEZONE: "WINDOW_INVALID_TIMEZONE",
    INVALID_RANGE_DATE: "WINDOW_INVALID_RANGE_DATE",
} as const;

type WindowErrorCode =
    (typeof WINDOW_ERROR_CODES)[keyof typeof WINDOW_ERROR_CODES];

export class WindowError extends Error {
    readonly code: WindowErrorCode;
    constructor(
        code: WindowErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "WindowError";
        this.code = code;
    }
}
