export const GITHUB_ERROR_CODES = {
    TOKEN_MISSING: "GITHUB_TOKEN_MISSING",
    TICKETS_NOT_CONFIGURED: "GITHUB_TICKETS_NOT_CONFIGURED",
    ORIGIN_MISSING: "GITHUB_ORIGIN_MISSING",
    ORIGIN_NOT_GITHUB: "GITHUB_ORIGIN_NOT_GITHUB",
    SLUG_INVALID: "GITHUB_SLUG_INVALID",
    REQUEST_FAILED: "GITHUB_REQUEST_FAILED",
    UNAUTHORIZED: "GITHUB_UNAUTHORIZED",
    QUERY_FAILED: "GITHUB_QUERY_FAILED",
    RESPONSE_INVALID: "GITHUB_RESPONSE_INVALID",
} as const;

type GitHubErrorCode =
    (typeof GITHUB_ERROR_CODES)[keyof typeof GITHUB_ERROR_CODES];

export class GitHubError extends Error {
    readonly code: GitHubErrorCode;
    constructor(
        code: GitHubErrorCode,
        message: string,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "GitHubError";
        this.code = code;
    }
}
