import { tryCatch } from "@spanical/utils";
import type { z } from "zod";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";
import { graphqlEnvelopeSchema, type RateLimit } from "./schemas";

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
const UNAUTHORIZED_STATUS = 401;
const ERROR_BODY_LIMIT = 500;
const RATE_LIMIT_FLOOR = 100;
// One page costs far more than a point, so a fixed floor is not enough headroom:
// the cost of the page just fetched is the only honest predictor of the next.
const COST_HEADROOM = 2;

export type GraphQLTransport = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string }
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

    const { data: payload, error } = await tryCatch<unknown>(response.json());
    if (error) {
        const failure = `GitHub GraphQL ${queryName} returned a body that is not JSON`;
        throw new GitHubError(
            GITHUB_ERROR_CODES.RESPONSE_INVALID,
            `${failure}: ${error.message}`,
            { cause: error, artifactMessage: `${failure}.` }
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
    const response = await options.transport(GITHUB_GRAPHQL_URL, {
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
    });

    const data = await readGraphQLData(response, options.queryName);
    const parsed = options.schema.safeParse(data);
    if (!parsed.success) {
        const failure = `GitHub GraphQL ${options.queryName} returned an unexpected shape`;
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
