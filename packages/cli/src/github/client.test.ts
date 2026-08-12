import { expect, jest, spyOn, test } from "bun:test";
import { z } from "zod";
import { tryCatch } from "@spanical/utils";
import issuesFixture from "./fixtures/issues-page.json";
import pullRequestsFixture from "./fixtures/pull-requests-page.json";
import {
    applyRateLimitBackoff,
    REQUEST_TIMEOUT_MS,
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

test("network failures retry until the transport succeeds", async () => {
    let attempts = 0;
    const signals: AbortSignal[] = [];
    const transport: GraphQLTransport = (_url, init) => {
        attempts += 1;
        signals.push(init.signal);
        if (attempts <= 2) {
            return Promise.reject(new Error("connection reset"));
        }
        return Promise.resolve(
            Response.json({ data: { ok: true } }, { status: 200 })
        );
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );

    try {
        const result = await runGraphQLQuery({
            query: "query Probe { ok }",
            queryName: "probe",
            variables: { cursor: null },
            schema: PROBE_SCHEMA,
            token: TOKEN,
            transport,
        });

        expect(result).toEqual({ ok: true });
        expect(attempts).toBe(3);
        expect(signals.map((signal) => signal.aborted)).toEqual([
            true,
            true,
            false,
        ]);
        const notices = stderr.mock.calls
            .map((call) => String(call[0]))
            .join("");
        expect(notices).toContain("connection reset");
        expect(stderr).toHaveBeenCalledTimes(2);
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("a stalled response body times out, aborts, and retries", async () => {
    let attempts = 0;
    let stalledBodyController:
        ReadableStreamDefaultController<Uint8Array> | undefined;
    let markFirstRequestStarted: (() => void) | undefined;
    const firstRequestStarted = new Promise<void>((resolve) => {
        markFirstRequestStarted = resolve;
    });
    const signals: AbortSignal[] = [];
    const transport: GraphQLTransport = (_url, init) => {
        attempts += 1;
        signals.push(init.signal);
        if (attempts === 1) {
            markFirstRequestStarted?.();
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    stalledBodyController = controller;
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        }
        return Promise.resolve(
            Response.json({ data: { ok: true } }, { status: 200 })
        );
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );
    jest.useFakeTimers();
    const query = runGraphQLQuery({
        query: "query Probe { ok }",
        queryName: "probe",
        variables: { cursor: null },
        schema: PROBE_SCHEMA,
        token: TOKEN,
        transport,
    });

    try {
        await firstRequestStarted;
        jest.advanceTimersByTime(REQUEST_TIMEOUT_MS);
        const result = await query;

        expect(signals[0]?.aborted).toBe(true);
        expect(result).toEqual({ ok: true });
        expect(attempts).toBe(2);
    } finally {
        stalledBodyController?.close();
        jest.useRealTimers();
        sleep.mockRestore();
        stderr.mockRestore();
        await tryCatch(query);
    }
});

test("transient failures wait with exponential backoff", async () => {
    let attempts = 0;
    const transport: GraphQLTransport = () => {
        attempts += 1;
        if (attempts <= 3) {
            return Promise.reject(new Error("connection reset"));
        }
        return Promise.resolve(
            Response.json({ data: { ok: true } }, { status: 200 })
        );
    };
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );

    try {
        await runGraphQLQuery({
            query: "query Probe { ok }",
            queryName: "probe",
            variables: { cursor: null },
            schema: PROBE_SCHEMA,
            token: TOKEN,
            transport,
        });

        expect(sleep.mock.calls.map((call) => call[0])).toEqual([
            500, 1_000, 2_000,
        ]);
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("a network failure while reading the response body is retried", async () => {
    let attempts = 0;
    const transport: GraphQLTransport = () => {
        attempts += 1;
        if (attempts === 1) {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.error(
                        new Error("connection reset while reading")
                    );
                },
            });
            return Promise.resolve(new Response(body, { status: 200 }));
        }
        return Promise.resolve(
            Response.json({ data: { ok: true } }, { status: 200 })
        );
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );

    try {
        const result = await runGraphQLQuery({
            query: "query Probe { ok }",
            queryName: "probe",
            variables: { cursor: null },
            schema: PROBE_SCHEMA,
            token: TOKEN,
            transport,
        });

        expect(result).toEqual({ ok: true });
        expect(attempts).toBe(2);
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("an exception from response validation is not retried", async () => {
    const validationError = new Error("validation crashed");
    const schema = z.preprocess(() => {
        throw validationError;
    }, PROBE_SCHEMA);
    const { transport, captured } = respondWith(
        JSON.stringify({ data: { ok: true } })
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );

    try {
        const { error } = await tryCatch(
            runGraphQLQuery({
                query: "query Probe { ok }",
                queryName: "probe",
                variables: { cursor: null },
                schema,
                token: TOKEN,
                transport,
            })
        );

        expect(captured).toHaveLength(1);
        expect(error).toBeInstanceOf(GitHubError);
        if (error instanceof GitHubError) {
            expect(error.code).toBe(GITHUB_ERROR_CODES.RESPONSE_INVALID);
            expect(error.cause).toBe(validationError);
        }
    } finally {
        stderr.mockRestore();
    }
});

test("server failures retry until the transport succeeds", async () => {
    let attempts = 0;
    const transport: GraphQLTransport = () => {
        attempts += 1;
        if (attempts <= 2) {
            return Promise.resolve(
                new Response("unavailable", { status: 503 })
            );
        }
        return Promise.resolve(
            Response.json({ data: { ok: true } }, { status: 200 })
        );
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );

    try {
        const result = await runGraphQLQuery({
            query: "query Probe { ok }",
            queryName: "probe",
            variables: { cursor: null },
            schema: PROBE_SCHEMA,
            token: TOKEN,
            transport,
        });

        expect(result).toEqual({ ok: true });
        expect(attempts).toBe(3);
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("a 401 becomes a coded unauthorized error that never echoes the token", async () => {
    const { error, captured } = await runProbe(
        JSON.stringify({ message: "Bad" }),
        401
    );
    expect(error).toBeInstanceOf(GitHubError);
    expect(captured).toHaveLength(1);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.UNAUTHORIZED);
        expect(error.message).not.toContain(TOKEN);
    }
});

test("a non-ok status becomes a request failure carrying the body, not the token", async () => {
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );

    try {
        const { error, captured } = await runProbe(
            JSON.stringify({ message: "We couldn't respond in time." }),
            502
        );
        expect(error).toBeInstanceOf(GitHubError);
        expect(captured).toHaveLength(4);
        if (error instanceof GitHubError) {
            expect(error.code).toBe(GITHUB_ERROR_CODES.REQUEST_FAILED);
            expect(error.message).toContain("502");
            expect(error.message).toContain("couldn't respond in time");
            expect(error.message).not.toContain(TOKEN);
        }
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("a body that is not JSON becomes an invalid-response error", async () => {
    const { error } = await runProbe("<html>gateway</html>");
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.RESPONSE_INVALID);
        expect(error.message).toContain("returned a body that is not JSON: ");
        expect(error.artifactMessage).toBe(
            "GitHub GraphQL probe returned a body that is not JSON."
        );
    }
});

test("a 200 carrying a populated errors array fails before any data is read", async () => {
    const { error, captured } = await runProbe(
        JSON.stringify({
            data: { ok: true },
            errors: [
                {
                    message:
                        "Could not resolve to a Repository with the name 'acme/web-app'",
                },
            ],
        })
    );
    expect(error).toBeInstanceOf(GitHubError);
    expect(captured).toHaveLength(1);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.QUERY_FAILED);
        expect(error.message).toContain("Could not resolve to a Repository");
        expect(error.message).toContain("acme/web-app");
        expect(error.artifactMessage).toBe(
            "GitHub GraphQL probe returned 1 error(s)."
        );
    }
});

test("a secondary rate limit waits for Retry-After before retrying", async () => {
    let attempts = 0;
    const transport: GraphQLTransport = () => {
        attempts += 1;
        if (attempts === 1) {
            return Promise.resolve(
                new Response("secondary rate limit", {
                    status: 403,
                    headers: { "Retry-After": "2" },
                })
            );
        }
        return Promise.resolve(
            Response.json({ data: { ok: true } }, { status: 200 })
        );
    };
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );

    try {
        const result = await runGraphQLQuery({
            query: "query Probe { ok }",
            queryName: "probe",
            variables: { cursor: null },
            schema: PROBE_SCHEMA,
            token: TOKEN,
            transport,
        });

        expect(result).toEqual({ ok: true });
        expect(attempts).toBe(2);
        expect(sleep).toHaveBeenCalledWith(2_000);
        expect(
            stderr.mock.calls.map((call) => String(call[0])).join("")
        ).toContain("waiting 2000ms");
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("a 403 without Retry-After is not retried", async () => {
    const { error, captured } = await runProbe("forbidden", 403);

    expect(error).toBeInstanceOf(GitHubError);
    expect(captured).toHaveLength(1);
});

test("a 403 with a blank Retry-After is not retried", async () => {
    let attempts = 0;
    const transport: GraphQLTransport = () => {
        attempts += 1;
        return Promise.resolve(
            new Response("forbidden", {
                status: 403,
                headers: { "Retry-After": " " },
            })
        );
    };
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );

    try {
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

        expect(error).toBeInstanceOf(GitHubError);
        expect(attempts).toBe(1);
    } finally {
        stderr.mockRestore();
    }
});

test("a 403 with Retry-After above the maximum is not retried", async () => {
    let attempts = 0;
    const transport: GraphQLTransport = () => {
        attempts += 1;
        return Promise.resolve(
            new Response("secondary rate limit", {
                status: 403,
                headers: { "Retry-After": "61" },
            })
        );
    };
    const sleep = spyOn(Bun, "sleep").mockImplementation(() =>
        Promise.resolve()
    );
    const stderr = spyOn(process.stderr, "write").mockImplementation(
        () => true
    );

    try {
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

        expect(error).toBeInstanceOf(GitHubError);
        expect(attempts).toBe(1);
        expect(sleep).not.toHaveBeenCalled();
    } finally {
        sleep.mockRestore();
        stderr.mockRestore();
    }
});

test("data that does not match the schema becomes an invalid-response error", async () => {
    const { error } = await runProbe(JSON.stringify({ data: { ok: "yes" } }));
    expect(error).toBeInstanceOf(GitHubError);
    if (error instanceof GitHubError) {
        expect(error.code).toBe(GITHUB_ERROR_CODES.RESPONSE_INVALID);
        expect(error.message).toContain("ok");
        expect(error.message).toContain("expected boolean");
        expect(error.artifactMessage).toBe(
            "GitHub GraphQL probe returned an unexpected shape."
        );
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
