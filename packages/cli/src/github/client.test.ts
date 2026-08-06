import { expect, test } from "bun:test";
import { z } from "zod";
import { tryCatch } from "@spanical/utils";
import issuesFixture from "./fixtures/issues-page.json";
import pullRequestsFixture from "./fixtures/pull-requests-page.json";
import {
    applyRateLimitBackoff,
    runGraphQLQuery,
    shouldBackoff,
    type GraphQLTransport,
} from "./client";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";
import { buildPullRequestRow, buildReviewRows } from "./rows";
import { issuePageSchema, pullRequestPageSchema } from "./schemas";
import type { LoginResolver } from "./identity";

const TOKEN = "secret-token-value";
const PROBE_SCHEMA = z.object({ ok: z.boolean() });

type Captured = { url: string; headers: Record<string, string>; body: string };

function respondWith(
    body: string,
    status = 200
): { transport: GraphQLTransport; captured: Captured[] } {
    const captured: Captured[] = [];
    const transport: GraphQLTransport = (url, init) => {
        captured.push({ url, headers: init.headers, body: init.body });
        return Promise.resolve(new Response(body, { status }));
    };
    return { transport, captured };
}

async function runProbe(
    body: string,
    status = 200
): Promise<{ error: Error | null; captured: Captured[] }> {
    const { transport, captured } = respondWith(body, status);
    const { error } = await tryCatch(
        runGraphQLQuery({
            query: "query Probe { ok }",
            queryName: "probe",
            variables: { cursor: null },
            schema: PROBE_SCHEMA,
            token: TOKEN,
            transport,
        })
    );
    return { error, captured };
}

function countingResolver(): LoginResolver & { credited: string[] } {
    const credited: string[] = [];
    return {
        credited,
        resolve: (login) => {
            credited.push(login);
            return credited.length;
        },
        bridgedLogins: () => new Set(),
    };
}

test("a successful query returns parsed data and sends a bearer token", async () => {
    const { transport, captured } = respondWith(
        JSON.stringify({ data: { ok: true } })
    );
    const result = await runGraphQLQuery({
        query: "query Probe { ok }",
        queryName: "probe",
        variables: { cursor: null },
        schema: PROBE_SCHEMA,
        token: TOKEN,
        transport,
    });
    expect(result).toEqual({ ok: true });
    expect(captured[0]?.url).toBe("https://api.github.com/graphql");
    expect(captured[0]?.headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
});

test("a 401 becomes a coded unauthorized error that never echoes the token", async () => {
    const { error } = await runProbe(JSON.stringify({ message: "Bad" }), 401);
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.UNAUTHORIZED);
        expect(error.message).not.toContain(TOKEN);
    }
});

test("a non-ok status becomes a request failure carrying the body, not the token", async () => {
    const { error } = await runProbe(
        JSON.stringify({ message: "We couldn't respond in time." }),
        502
    );
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.REQUEST_FAILED);
        expect(error.message).toContain("502");
        expect(error.message).toContain("couldn't respond in time");
        expect(error.message).not.toContain(TOKEN);
    }
});

test("a body that is not JSON becomes an invalid-response error", async () => {
    const { error } = await runProbe("<html>gateway</html>");
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.RESPONSE_INVALID);
    }
});

test("a 200 carrying a populated errors array fails before any data is read", async () => {
    const { error } = await runProbe(
        JSON.stringify({
            data: { ok: true },
            errors: [{ message: "Could not resolve to a Repository" }],
        })
    );
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.QUERY_FAILED);
        expect(error.message).toContain("Could not resolve to a Repository");
    }
});

test("data that does not match the schema becomes an invalid-response error", async () => {
    const { error } = await runProbe(JSON.stringify({ data: { ok: "yes" } }));
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.RESPONSE_INVALID);
        expect(error.message).toContain("ok");
    }
});

test("backoff triggers on a low remaining and on a page costing more than headroom", () => {
    expect(shouldBackoff(null)).toBe(false);
    expect(
        shouldBackoff({
            cost: 5,
            remaining: 4900,
            resetAt: "2026-07-19T13:00:00Z",
        })
    ).toBe(false);
    expect(
        shouldBackoff({
            cost: 5,
            remaining: 99,
            resetAt: "2026-07-19T13:00:00Z",
        })
    ).toBe(true);
    // remaining clears the fixed floor but not twice the observed page cost.
    expect(
        shouldBackoff({
            cost: 400,
            remaining: 500,
            resetAt: "2026-07-19T13:00:00Z",
        })
    ).toBe(true);
});

test("backoff returns immediately when the reset window has already passed", async () => {
    const startedAt = Date.now();
    await applyRateLimitBackoff({
        cost: 5,
        remaining: 0,
        resetAt: "2020-01-01T00:00:00Z",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("a recorded pull-request page still satisfies the response schema", () => {
    const page = pullRequestPageSchema.parse(pullRequestsFixture);
    const nodes = page.repository.pullRequests.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(0);

    const resolver = countingResolver();
    for (const node of nodes) {
        if (node === null) {
            continue;
        }
        const row = buildPullRequestRow(resolver, "web-app", node);
        expect(row.kind).toBe("pr");
        expect(Number.isFinite(row.createdAt)).toBe(true);
        expect(Number.isFinite(row.updatedAt)).toBe(true);
        // Only that reopened deserialises to a number. The guard against a
        // regression to totalCount (which ignores itemTypes and would turn every
        // pull request into a reopened one) is the schema: it requires the
        // filteredCount key, so the query and the parser cannot drift apart.
        expect(row.reopenedCount).toBe(0);
        buildReviewRows(resolver, "web-app", node);
    }
    expect(resolver.credited.length).toBeGreaterThan(0);
});

test("a recorded issue page still satisfies the response schema", () => {
    const page = issuePageSchema.parse(issuesFixture);
    const nodes = page.repository.issues.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(0);
    expect(page.rateLimit?.cost).toBeGreaterThan(0);
});
