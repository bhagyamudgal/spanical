import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tryCatch } from "@spanical/utils";
import { openCache } from "../cache/open";
import { authorGithubLogins, authors } from "../cache/schema";
import { parseConfig } from "../config/load";
import { seedAndResolveAuthors } from "../extract/authors";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";
import { bridgeGithubLogins, formatUnmappedLoginsWarning } from "./identity";
import { parseGitHubRemote, resolveRepoSlug } from "./slug";
import { resolveFetchFloors } from "./sync";

type Handle = ReturnType<typeof openCache>;

const SLUG = "acme/web";

function git(cwd: string, args: string[]): void {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`
        );
    }
}

function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-gh-repo-"));
    git(dir, ["init", "-q", "-b", "main"]);
    return dir;
}

function withCache<T>(fn: (handle: Handle) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "spanical-gh-cache-"));
    const handle = openCache({ cwd: dir });
    try {
        return fn(handle);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

function loginRow(handle: Handle, login: string): number | null {
    const row = handle.db
        .select({ authorId: authorGithubLogins.authorId })
        .from(authorGithubLogins)
        .where(eq(authorGithubLogins.login, login))
        .get();
    return row?.authorId ?? null;
}

function authorId(handle: Handle, canonicalName: string): number | null {
    const row = handle.db
        .select({ id: authors.id })
        .from(authors)
        .where(eq(authors.canonicalName, canonicalName))
        .get();
    return row?.id ?? null;
}

test("parseGitHubRemote reads the slug from the SSH and HTTPS remote forms", () => {
    expect(parseGitHubRemote("git@github.com:acme/web.git")).toEqual({
        owner: "acme",
        name: "web",
    });
    expect(parseGitHubRemote("https://github.com/acme/web.git")).toEqual({
        owner: "acme",
        name: "web",
    });
    expect(parseGitHubRemote("https://github.com/acme/web")).toEqual({
        owner: "acme",
        name: "web",
    });
    expect(parseGitHubRemote("ssh://git@github.com/acme/web.git\n")).toEqual({
        owner: "acme",
        name: "web",
    });
});

test("parseGitHubRemote returns null for remotes that are not github.com", () => {
    expect(parseGitHubRemote("git@gitlab.com:acme/web.git")).toBeNull();
    expect(parseGitHubRemote("https://example.com/acme/web.git")).toBeNull();
    expect(parseGitHubRemote("/srv/mirrors/web.git")).toBeNull();
    expect(parseGitHubRemote("https://github.com/acme")).toBeNull();
});

test("resolveRepoSlug fails clearly when the repo has no origin remote", async () => {
    const repo = initRepo();
    try {
        const { error } = await tryCatch(
            resolveRepoSlug({ name: "web-app", path: repo })
        );
        expect(error).toBeInstanceOf(GitHubError);
        if (error instanceof GitHubError) {
            expect(error.code).toBe(GITHUB_ERROR_CODES.ORIGIN_MISSING);
            expect(error.message).toContain("web-app");
        }
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("resolveRepoSlug fails clearly when origin is not a GitHub host", async () => {
    const repo = initRepo();
    try {
        git(repo, ["remote", "add", "origin", "git@gitlab.com:acme/web.git"]);
        const { error } = await tryCatch(
            resolveRepoSlug({ name: "web-app", path: repo })
        );
        expect(error).toBeInstanceOf(GitHubError);
        if (error instanceof GitHubError) {
            expect(error.code).toBe(GITHUB_ERROR_CODES.ORIGIN_NOT_GITHUB);
            expect(error.message).toContain("gitlab.com");
        }
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("resolveRepoSlug reads origin, and a config github entry overrides it", async () => {
    const repo = initRepo();
    try {
        git(repo, ["remote", "add", "origin", "git@github.com:acme/web.git"]);
        expect(await resolveRepoSlug({ name: "web-app", path: repo })).toEqual({
            owner: "acme",
            name: "web",
        });
        expect(
            await resolveRepoSlug({
                name: "web-app",
                path: repo,
                github: "acme/web-fork",
            })
        ).toEqual({ owner: "acme", name: "web-fork" });
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("both noreply email forms auto-bridge to their GitHub login", () => {
    withCache((handle) => {
        const config = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            authors: {
                "dev-one": {
                    emails: ["12345+dev-one-gh@users.noreply.github.com"],
                },
                "dev-two": {
                    emails: ["dev-two-gh@users.noreply.github.com"],
                },
            },
        });
        seedAndResolveAuthors(handle.db, config);
        bridgeGithubLogins(handle.db, config);

        expect(loginRow(handle, "dev-one-gh")).toBe(
            authorId(handle, "dev-one") ?? -1
        );
        expect(loginRow(handle, "dev-two-gh")).toBe(
            authorId(handle, "dev-two") ?? -1
        );
    });
});

test("a configured github entry beats a noreply auto-bridge for the same login", () => {
    withCache((handle) => {
        const config = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            authors: {
                "dev-one": {
                    emails: ["12345+shared-gh@users.noreply.github.com"],
                },
                "dev-two": {
                    emails: ["dev-two@example.com"],
                    github: ["shared-gh"],
                },
            },
        });
        seedAndResolveAuthors(handle.db, config);
        const resolver = bridgeGithubLogins(handle.db, config);

        const expected = authorId(handle, "dev-two") ?? -1;
        expect(loginRow(handle, "shared-gh")).toBe(expected);
        expect(resolver.resolve("shared-gh")).toBe(expected);
    });
});

test("an unmapped login mints a provisional author bound to its login", () => {
    withCache((handle) => {
        const config = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
        });
        const resolver = bridgeGithubLogins(handle.db, config);

        const provisionalId = resolver.resolve("stranger-gh");
        expect(authorId(handle, "stranger-gh")).toBe(provisionalId);
        expect(loginRow(handle, "stranger-gh")).toBe(provisionalId);
        expect(resolver.bridgedLogins().has("stranger-gh")).toBe(false);
    });
});

test("the unmapped warning prints the config block that would merge the login", () => {
    const warning = formatUnmappedLoginsWarning(["stranger-gh"]);
    expect(warning).toContain("authors: {");
    expect(warning).toContain(
        '"stranger-gh": { emails: ["..."], github: ["stranger-gh"] },'
    );
});

test("logins differing only in case resolve to one canonical author", () => {
    withCache((handle) => {
        const config = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            authors: {
                "dev-one": {
                    emails: ["dev-one@example.com"],
                    github: ["Dev-One-GH"],
                },
            },
        });
        const resolver = bridgeGithubLogins(handle.db, config);
        const expected = authorId(handle, "dev-one") ?? -1;

        expect(resolver.resolve("dev-one-gh")).toBe(expected);
        expect(resolver.resolve("DEV-ONE-GH")).toBe(expected);
        expect(handle.db.select().from(authors).all()).toHaveLength(1);
    });
});

test("a noreply auto-bridge merges with the API's canonical login casing", () => {
    withCache((handle) => {
        const config = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            authors: {
                "dev-one": {
                    emails: ["99+dev-one-gh@users.noreply.github.com"],
                },
            },
        });
        seedAndResolveAuthors(handle.db, config);
        const resolver = bridgeGithubLogins(handle.db, config);

        expect(resolver.resolve("Dev-One-GH")).toBe(
            authorId(handle, "dev-one") ?? -1
        );
    });
});

test("deleting a github entry from config prunes its stale binding", () => {
    withCache((handle) => {
        const before = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            authors: {
                "dev-one": {
                    emails: ["dev-one@example.com"],
                    github: ["dev-one-gh"],
                },
            },
        });
        seedAndResolveAuthors(handle.db, before);
        bridgeGithubLogins(handle.db, before);
        expect(loginRow(handle, "dev-one-gh")).not.toBeNull();

        const after = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            authors: { "dev-one": { emails: ["dev-one@example.com"] } },
        });
        bridgeGithubLogins(handle.db, after);
        expect(loginRow(handle, "dev-one-gh")).toBeNull();
    });
});

test("a provisional binding survives pruning so cached tickets keep their author", () => {
    withCache((handle) => {
        const config = parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
        });
        const first = bridgeGithubLogins(handle.db, config);
        const provisionalId = first.resolve("stranger-gh");

        bridgeGithubLogins(handle.db, config);
        expect(loginRow(handle, "stranger-gh")).toBe(provisionalId);
    });
});

const UTC = { since: null, timezone: "UTC" };

function cursorAt(overrides: {
    slug?: string;
    since?: string | null;
    syncedThrough?: number;
    issuesSyncedThrough?: number;
}) {
    return {
        slug: SLUG,
        since: null,
        syncedThrough: 5_000,
        issuesSyncedThrough: 5_000,
        ...overrides,
    };
}

test("an unchanged since resumes both watermarks from the cursor", () => {
    expect(
        resolveFetchFloors(
            cursorAt({ since: "2025-01-01", issuesSyncedThrough: 4_000 }),
            SLUG,
            { since: "2025-01-01", timezone: "UTC" }
        )
    ).toEqual({
        pullRequests: 5_000,
        issues: 4_000,
        isRepointed: false,
    });
});

test("a since that moves earlier re-backfills from the new bound", () => {
    expect(
        resolveFetchFloors(cursorAt({ since: "2025-06-01" }), SLUG, {
            since: "2025-01-01",
            timezone: "UTC",
        })
    ).toEqual({
        pullRequests: Date.parse("2025-01-01T00:00:00Z"),
        issues: Date.parse("2025-01-01T00:00:00Z"),
        isRepointed: false,
    });
    expect(
        resolveFetchFloors(cursorAt({ since: "2025-06-01" }), SLUG, UTC)
    ).toEqual({ pullRequests: 0, issues: 0, isRepointed: false });
});

test("a since that moves later or is newly set keeps the cache", () => {
    expect(
        resolveFetchFloors(cursorAt({ since: "2025-01-01" }), SLUG, {
            since: "2025-06-01",
            timezone: "UTC",
        }).pullRequests
    ).toBe(5_000);
    expect(
        resolveFetchFloors(cursorAt({ since: null }), SLUG, {
            since: "2025-06-01",
            timezone: "UTC",
        }).pullRequests
    ).toBe(5_000);
});

test("a repo with no cursor backfills from its since bound", () => {
    expect(
        resolveFetchFloors(null, SLUG, {
            since: "2025-01-01",
            timezone: "UTC",
        }).pullRequests
    ).toBe(Date.parse("2025-01-01T00:00:00Z"));
    expect(resolveFetchFloors(null, SLUG, UTC).pullRequests).toBe(0);
});

test("a repointed slug invalidates both watermarks and flags the repoint", () => {
    expect(
        resolveFetchFloors(cursorAt({ slug: "acme/old" }), SLUG, UTC)
    ).toEqual({ pullRequests: 0, issues: 0, isRepointed: true });
});

test("the since floor is the configured timezone's midnight, not UTC's", () => {
    const floors = resolveFetchFloors(null, SLUG, {
        since: "2025-01-01",
        timezone: "Asia/Kolkata",
    });
    expect(floors.pullRequests).toBe(Date.parse("2024-12-31T18:30:00Z"));
});
