export const GITHUB_ERROR_CODES = {
    TOKEN_MISSING: "GITHUB_TOKEN_MISSING",
    TICKETS_NOT_CONFIGURED: "GITHUB_TICKETS_NOT_CONFIGURED",
    ORIGIN_MISSING: "GITHUB_ORIGIN_MISSING",
    ORIGIN_NOT_GITHUB: "GITHUB_ORIGIN_NOT_GITHUB",
    SLUG_INVALID: "GITHUB_SLUG_INVALID",
    SLUG_DUPLICATE: "GITHUB_SLUG_DUPLICATE",
    REQUEST_FAILED: "GITHUB_REQUEST_FAILED",
    UNAUTHORIZED: "GITHUB_UNAUTHORIZED",
    QUERY_FAILED: "GITHUB_QUERY_FAILED",
    RESPONSE_INVALID: "GITHUB_RESPONSE_INVALID",
} as const;

type GitHubErrorCode =
    (typeof GITHUB_ERROR_CODES)[keyof typeof GITHUB_ERROR_CODES];

// The report writes a failed refresh into a Markdown artifact that is kept and
// shared, so it quotes artifactMessage rather than message: the same cause, minus
// the local detail — clone paths, remote URLs, response bodies — that is wanted on
// stderr and nowhere else. Messages carrying no such detail pass through unchanged.
export class GitHubError extends Error {
    readonly code: GitHubErrorCode;
    readonly artifactMessage: string;
    constructor(
        code: GitHubErrorCode,
        message: string,
        options?: { cause?: unknown; artifactMessage?: string }
    ) {
        super(message, options);
        this.name = "GitHubError";
        this.code = code;
        this.artifactMessage = options?.artifactMessage ?? message;
    }
}
