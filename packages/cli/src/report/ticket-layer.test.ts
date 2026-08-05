import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCatch } from "@spanical/utils";
import { openCache } from "../cache/open";
import { tickets } from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import { parseConfig } from "../config/load";
import type { SpanicalUserConfig } from "../config/schema";
import type { ResolvedWindow } from "../window/types";
import { collectTicketInsight, refreshTicketCache } from "./ticket-layer";

const NOW = new Date("2025-08-01T00:00:00Z");

const WINDOW: ResolvedWindow = {
    start: new Date(Date.UTC(2025, 5, 1)),
    end: new Date(Date.UTC(2025, 7, 1)),
    granularity: "month",
    periods: [],
    label: "2025-06 – 2025-07",
};

const TICKETS_CONFIG: SpanicalUserConfig["tickets"] = {
    source: "github",
    github: { token: "env:GITHUB_TOKEN", includeIssues: false },
};

function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-ticket-layer-repo-"));
    const result = Bun.spawnSync(["git", "init", "-q", "-b", "main"], {
        cwd: dir,
    });
    if (result.exitCode !== 0) {
        throw new Error(`git init failed: ${result.stderr.toString()}`);
    }
    return dir;
}

function buildRun(
    repoPath: string,
    ticketsConfig: SpanicalUserConfig["tickets"]
): ResolvedRun {
    const repos = [{ name: "web-app", path: repoPath }];
    return {
        repos,
        config: parseConfig({ repos, tickets: ticketsConfig }),
        tz: "UTC",
        exclude: [],
        by: null,
        format: "md",
        out: null,
        cache: true,
        window: WINDOW,
    };
}

function seedTicket(handle: ReturnType<typeof openCache>): void {
    handle.db
        .insert(tickets)
        .values({
            nodeId: "pr-1",
            repo: "web-app",
            kind: "pr",
            number: 1,
            title: "feat: app",
            author: "dev-one-gh",
            authorIsBot: false,
            assignee: "dev-one-gh",
            assigneeIsBot: false,
            closedBy: null,
            closedByIsBot: false,
            createdAt: Date.UTC(2025, 5, 10),
            closedAt: null,
            mergedAt: null,
            updatedAt: Date.UTC(2025, 5, 10),
            state: "OPEN",
            reopenedCount: 0,
            additions: 10,
            deletions: 1,
        })
        .run();
}

async function withToken<T>(
    token: string | null,
    body: () => Promise<T>
): Promise<T> {
    const configured = process.env.GITHUB_TOKEN;
    if (token === null) {
        delete process.env.GITHUB_TOKEN;
    } else {
        process.env.GITHUB_TOKEN = token;
    }
    try {
        return await body();
    } finally {
        if (configured === undefined) {
            delete process.env.GITHUB_TOKEN;
        } else {
            process.env.GITHUB_TOKEN = configured;
        }
    }
}

function openFixture(): { handle: ReturnType<typeof openCache>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "spanical-ticket-layer-"));
    return { handle: openCache({ cwd: dir }), dir };
}

test("refreshTicketCache stays off when the config has no tickets section", async () => {
    const repo = initRepo();
    const { handle, dir } = openFixture();
    try {
        const refresh = await withToken("test-token", () =>
            refreshTicketCache(handle.db, buildRun(repo, undefined), {
                now: NOW,
            })
        );

        expect(refresh).toBeNull();
    } finally {
        handle.sqlite.close();
        rmSync(repo, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

test("refreshTicketCache stays off when no token is exported", async () => {
    const repo = initRepo();
    const { handle, dir } = openFixture();
    try {
        const refresh = await withToken(null, () =>
            refreshTicketCache(handle.db, buildRun(repo, TICKETS_CONFIG), {
                now: NOW,
            })
        );

        expect(refresh).toBeNull();
    } finally {
        handle.sqlite.close();
        rmSync(repo, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

test("refreshTicketCache degrades with the reason when the refresh fails", async () => {
    const repo = initRepo();
    const { handle, dir } = openFixture();
    try {
        const refresh = await withToken("test-token", () =>
            refreshTicketCache(handle.db, buildRun(repo, TICKETS_CONFIG), {
                now: NOW,
            })
        );

        expect(refresh?.attribution).toBe("assignee");
        expect(refresh?.includeIssues).toBe(false);
        expect(refresh?.failure?.reason).toContain('has no "origin" remote');
    } finally {
        handle.sqlite.close();
        rmSync(repo, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});

// Anything that is not a GitHub failure — a cache write dying on a full disk,
// a broken git checkout — must stop the report rather than be disclosed as an
// unreachable ticket layer and have its numbers reported as if they were whole.
test("refreshTicketCache lets a non-GitHub failure abort the report", async () => {
    const missingRepo = join(tmpdir(), "spanical-ticket-layer-absent");
    const { handle, dir } = openFixture();
    try {
        const { error } = await withToken("test-token", () =>
            tryCatch(
                refreshTicketCache(
                    handle.db,
                    buildRun(missingRepo, TICKETS_CONFIG),
                    { now: NOW }
                )
            )
        );

        expect(error).not.toBeNull();
        expect(error?.message).not.toContain("the GitHub refresh did not");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("collectTicketInsight scopes the cache check to the repos it covers", async () => {
    const repo = initRepo();
    const { handle, dir } = openFixture();
    try {
        seedTicket(handle);
        const run = buildRun(repo, TICKETS_CONFIG);
        const refresh = await withToken("test-token", () =>
            refreshTicketCache(handle.db, run, { now: NOW })
        );
        if (refresh === null) {
            throw new Error("Expected the ticket layer to be on");
        }

        expect(
            collectTicketInsight(handle.db, run, refresh, ["web-app"])
                .hasCachedTickets
        ).toBe(true);
        expect(
            collectTicketInsight(handle.db, run, refresh, ["api"])
                .hasCachedTickets
        ).toBe(false);
    } finally {
        handle.sqlite.close();
        rmSync(repo, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
});
