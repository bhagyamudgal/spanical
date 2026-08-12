import {
    tryCatch,
    tryCatchRetry,
    tryCatchSync,
    tryCatchWithTimeout,
} from "@spanical/utils";
import type { z } from "zod";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";
import { graphqlEnvelopeSchema, type RateLimit } from "./schemas";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
const UNAUTHORIZED_STATUS = 401;
const SECONDARY_RATE_LIMIT_STATUS = 403;
const RETRY_AFTER_HEADER = "Retry-After";
const RETRY_AFTER_MAX_MS = 60_000;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_BACKOFF_FACTOR = 2;
const ERROR_BODY_LIMIT = 500;
const RATE_LIMIT_FLOOR = 100;
export const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_MAX_RETRIES = 3;
const SERVER_ERROR_STATUS_MIN = 500;
const SERVER_ERROR_STATUS_MAX = 599;
// One page costs far more than a point, so a fixed floor is not enough headroom:
// the cost of the page just fetched is the only honest predictor of the next.
const COST_HEADROOM = 2;

class RetryableResponseError extends Error {
    readonly githubError: GitHubError;
    readonly retryAfterMs: number;

    constructor(githubError: GitHubError, retryAfterMs = 0) {
        super(githubError.message, { cause: githubError });
        this.name = "RetryableResponseError";
        this.githubError = githubError;
        this.retryAfterMs = retryAfterMs;
    }
}

class RetryableRequestError extends Error {
    readonly requestError: Error;

    constructor(requestError: Error) {
        super(requestError.message, { cause: requestError });
        this.name = "RetryableRequestError";
        this.requestError = requestError;
    }
}

function retryAfterMs(response: Response): number | null {
    if (response.status !== SECONDARY_RATE_LIMIT_STATUS) {
        return null;
    }
    const retryAfter = response.headers.get(RETRY_AFTER_HEADER);
    if (retryAfter === null || retryAfter.trim().length === 0) {
        return null;
    }
    const seconds = Number(retryAfter);
    if (!Number.isFinite(seconds) || seconds < 0) {
        return null;
    }
    const waitMs = seconds * 1_000;
    return waitMs <= RETRY_AFTER_MAX_MS ? waitMs : null;
}

function calculateRetryDelayMs(retry: number): number {
    return RETRY_BASE_DELAY_MS * RETRY_BACKOFF_FACTOR ** (retry - 1);
}

export type GraphQLTransport = (
    url: string,
    init: {
        method: string;
        headers: Record<string, string>;
        body: string;
        signal: AbortSignal;
    }
) => Promise<Response>;

// The report treats a missing token as "the ticket layer is off" rather than as
// an error, so it needs to ask without being thrown at.
export function findGithubToken(): string | null {
    const token = process.env[GITHUB_TOKEN_ENV];
    return token === undefined || token.length === 0 ? null : token;
}

export function resolveGithubToken(): string {
    const token = findGithubToken();
    if (token === null) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.TOKEN_MISSING,
            `${GITHUB_TOKEN_ENV} is not set. Export a fine-grained personal access token with read access to the repositories you are analysing.`
        );
    }
    return token;
}

// The token never reaches an error message: only the status line and a truncated
// response body are surfaced.
async function readGraphQLData(
    response: Response,
    queryName: string
): Promise<unknown> {
    if (response.status === UNAUTHORIZED_STATUS) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.UNAUTHORIZED,
            `GitHub rejected the ${GITHUB_TOKEN_ENV} credential (401). Check that the token is valid and has read access to the repository.`
        );
    }
    if (!response.ok) {
        // The status is the useful fact here, so a body that fails mid-stream
        // must not replace it with a stream error.
        const failure = `GitHub GraphQL ${queryName} failed with status ${response.status}`;
        const { data: body } = await tryCatch(response.text());
        throw new GitHubError(
            GITHUB_ERROR_CODES.REQUEST_FAILED,
            `${failure}: ${(body ?? "").slice(0, ERROR_BODY_LIMIT)}`,
            { artifactMessage: `${failure}.` }
        );
    }

    const { data: body, error: readError } = await tryCatch(response.text());
    if (readError) {
        throw new RetryableRequestError(readError);
    }
    const { data: payload, error: parseError } = tryCatchSync<unknown>(() =>
        JSON.parse(body)
    );
    if (parseError) {
        const failure = `GitHub GraphQL ${queryName} returned a body that is not JSON`;
        throw new GitHubError(
            GITHUB_ERROR_CODES.RESPONSE_INVALID,
            `${failure}: ${parseError.message}`,
            { cause: parseError, artifactMessage: `${failure}.` }
        );
    }

    const envelope = graphqlEnvelopeSchema.safeParse(payload);
    if (!envelope.success) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.RESPONSE_INVALID,
            `GitHub GraphQL ${queryName} returned an unrecognised envelope.`,
            { cause: envelope.error }
        );
    }
    const messages = envelope.data.errors ?? [];
    if (messages.length > 0) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.QUERY_FAILED,
            `GitHub GraphQL ${queryName} returned errors: ${messages.map((entry) => entry.message).join("; ")}`,
            {
                artifactMessage: `GitHub GraphQL ${queryName} returned ${messages.length} error(s).`,
            }
        );
    }
    return envelope.data.data;
}

export async function runGraphQLQuery<Schema extends z.ZodType>(options: {
    query: string;
    queryName: string;
    variables: Record<string, string | null>;
    schema: Schema;
    token: string;
    transport: GraphQLTransport;
}): Promise<z.infer<Schema>> {
    async function sendRequest(signal: AbortSignal): Promise<Response> {
        return options.transport(GITHUB_GRAPHQL_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${options.token}`,
                "Content-Type": "application/json",
                "User-Agent": "spanical",
            },
            body: JSON.stringify({
                query: options.query,
                variables: options.variables,
            }),
            signal,
        });
    }

    async function execute(signal: AbortSignal): Promise<z.infer<Schema>> {
        const transportResult = await tryCatch(sendRequest(signal));
        if (transportResult.error) {
            throw new RetryableRequestError(transportResult.error);
        }
        const response = transportResult.data;
        const secondaryRateLimitWaitMs = retryAfterMs(response);
        const isServerError =
            response.status >= SERVER_ERROR_STATUS_MIN &&
            response.status <= SERVER_ERROR_STATUS_MAX;

        const result = await tryCatch(
            readAndParseGraphQLData(response, options.queryName, options.schema)
        );
        if (result.error === null) {
            return result.data;
        }
        if (
            result.error instanceof GitHubError &&
            (isServerError || secondaryRateLimitWaitMs !== null)
        ) {
            throw new RetryableResponseError(
                result.error,
                secondaryRateLimitWaitMs ?? 0
            );
        }
        throw result.error;
    }

    async function request(): Promise<z.infer<Schema>> {
        const abortController = new AbortController();
        let isExecutionComplete = false;

        async function trackExecution(): Promise<z.infer<Schema>> {
            const result = await tryCatch(execute(abortController.signal));
            isExecutionComplete = true;
            if (result.error) {
                throw result.error;
            }
            return result.data;
        }

        const result = await tryCatchWithTimeout(
            trackExecution(),
            REQUEST_TIMEOUT_MS
        );
        if (result.error) {
            abortController.abort();
            if (!isExecutionComplete) {
                throw new RetryableRequestError(result.error);
            }
            throw result.error;
        }
        return result.data;
    }

    const result = await tryCatchRetry(request, {
        maxRetries: REQUEST_MAX_RETRIES,
        delayMs(error, retry) {
            const retryAfter =
                error instanceof RetryableResponseError
                    ? error.retryAfterMs
                    : 0;
            return Math.max(retryAfter, calculateRetryDelayMs(retry));
        },
        shouldRetry(error) {
            return (
                error instanceof RetryableRequestError ||
                error instanceof RetryableResponseError
            );
        },
        onRetry(error, retry, delayMs) {
            const wait = delayMs > 0 ? ` waiting ${delayMs}ms, then` : "";
            process.stderr.write(
                `note: GitHub GraphQL ${options.queryName} failed: ${error.message};${wait} retrying (${retry} of ${REQUEST_MAX_RETRIES}).\n`
            );
        },
    });
    if (result.error) {
        if (result.error instanceof RetryableResponseError) {
            throw result.error.githubError;
        }
        if (result.error instanceof RetryableRequestError) {
            throw result.error.requestError;
        }
        throw result.error;
    }

    return result.data;
}

async function readAndParseGraphQLData<Schema extends z.ZodType>(
    response: Response,
    queryName: string,
    schema: Schema
): Promise<z.infer<Schema>> {
    const data = await readGraphQLData(response, queryName);
    const failure = `GitHub GraphQL ${queryName} returned an unexpected shape`;
    const { data: parsed, error } = tryCatchSync(() => schema.safeParse(data));
    if (error) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.RESPONSE_INVALID,
            `${failure}: ${error.message}`,
            { cause: error, artifactMessage: `${failure}.` }
        );
    }
    if (!parsed.success) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.RESPONSE_INVALID,
            `${failure}: ${parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")}`,
            { cause: parsed.error, artifactMessage: `${failure}.` }
        );
    }
    return parsed.data;
}

export function shouldBackoff(rateLimit: RateLimit | null): boolean {
    if (rateLimit === null) {
        return false;
    }
    const required = Math.max(RATE_LIMIT_FLOOR, rateLimit.cost * COST_HEADROOM);
    return rateLimit.remaining < required;
}

export async function applyRateLimitBackoff(
    rateLimit: RateLimit | null
): Promise<void> {
    if (rateLimit === null || !shouldBackoff(rateLimit)) {
        return;
    }
    const waitMs = Date.parse(rateLimit.resetAt) - Date.now();
    if (waitMs <= 0) {
        return;
    }
    process.stderr.write(
        `note: GitHub rate limit down to ${rateLimit.remaining} points against a page costing ${rateLimit.cost}; waiting until ${rateLimit.resetAt}.\n`
    );
    await Bun.sleep(waitMs);
}
