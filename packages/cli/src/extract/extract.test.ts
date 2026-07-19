import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { count, eq } from "drizzle-orm";
import { tryCatch } from "@spanical/utils";
import { openCache } from "../cache/open";
import { authors, commitAuthors, commits, fileChanges } from "../cache/schema";
import type { SpanicalUserConfig } from "../config/schema";
import { EXTRACT_ERROR_CODES, ExtractError } from "./errors";
import { resolveDefaultBranch } from "./git";
import { extractAll } from "./ingest";

const NOW = new Date("2026-07-19T12:00:00Z");
const PUBLIC_IMPORT = `${import.meta.dir}/../public`;

const DEV_ONE = { name: "dev-one", email: "dev-one@example.com" };
const DEV_TWO = { name: "dev-two", email: "dev-two@example.com" };

type Author = { name: string; email: string };
type Handle = ReturnType<typeof openCache>;

type CommitSpec = {
    message: string;
    author: Author;
    files?: Record<string, string>;
    binaryFiles?: Record<string, Uint8Array>;
    renames?: Array<{ from: string; to: string }>;
};

function git(cwd: string, args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`
        );
    }
    return result.stdout.toString();
}

function initRepo(branch: string): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-repo-"));
    git(dir, ["init", "-q", "-b", branch]);
    git(dir, ["config", "user.name", "ci"]);
    git(dir, ["config", "user.email", "ci@example.com"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    return dir;
}

function writeBlob(
    dir: string,
    path: string,
    content: string | Uint8Array
): void {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
}

function commit(dir: string, spec: CommitSpec): void {
    for (const rename of spec.renames ?? []) {
        git(dir, ["mv", rename.from, rename.to]);
    }
    for (const [path, content] of Object.entries(spec.files ?? {})) {
        writeBlob(dir, path, content);
    }
    for (const [path, content] of Object.entries(spec.binaryFiles ?? {})) {
        writeBlob(dir, path, content);
    }
    git(dir, ["add", "-A"]);
    git(dir, [
        "commit",
        "-q",
        "-m",
        spec.message,
        `--author=${spec.author.name} <${spec.author.email}>`,
    ]);
}

function writeConfig(config: SpanicalUserConfig): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-cfg-"));
    const source = `import { defineConfig } from "${PUBLIC_IMPORT}";\nexport default defineConfig(${JSON.stringify(config, null, 4)});\n`;
    writeFileSync(join(dir, "spanical.config.ts"), source);
    return dir;
}

function withCache<T>(configDir: string, fn: (handle: Handle) => T): T {
    const handle = openCache({ cwd: configDir });
    try {
        return fn(handle);
    } finally {
        handle.sqlite.close();
    }
}

function shaOfFile(handle: Handle, path: string): string {
    const row = handle.db
        .select({ sha: fileChanges.sha })
        .from(fileChanges)
        .where(eq(fileChanges.path, path))
        .get();
    if (!row) {
        throw new Error(`No file_changes row for ${path}`);
    }
    return row.sha;
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("stores rename destinations and marks binary files with null counts", async () => {
    const repo = initRepo("main");
    const cfg = writeConfig({ repos: [{ name: "web-app", path: repo }] });
    try {
        commit(repo, {
            message: "feat: first",
            author: DEV_ONE,
            files: { "src/old.ts": "hello\nworld\n" },
        });
        commit(repo, {
            message: "refactor: rename",
            author: DEV_ONE,
            renames: [{ from: "src/old.ts", to: "src/new.ts" }],
        });
        commit(repo, {
            message: "chore: add binary",
            author: DEV_ONE,
            binaryFiles: {
                "assets/logo.png": new Uint8Array([0, 1, 2, 0, 255, 0]),
            },
        });

        await extractAll({ cwd: cfg, noCache: true, now: NOW });

        withCache(cfg, (handle) => {
            const rename = handle.db
                .select()
                .from(fileChanges)
                .where(eq(fileChanges.path, "src/new.ts"))
                .get();
            expect(rename).toBeDefined();

            const binary = handle.db
                .select()
                .from(fileChanges)
                .where(eq(fileChanges.path, "assets/logo.png"))
                .get();
            expect(binary?.isBinary).toBe(true);
            expect(binary?.added).toBeNull();
            expect(binary?.deleted).toBeNull();
        });
    } finally {
        cleanup([repo, cfg]);
    }
});

test("credits co-authors with equal weights summing to one", async () => {
    const repo = initRepo("main");
    const cfg = writeConfig({ repos: [{ name: "web-app", path: repo }] });
    try {
        commit(repo, {
            message:
                "feat: pair\n\nCo-authored-by: dev-two <dev-two@example.com>",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        commit(repo, {
            message:
                "feat: mob\n\nCo-authored-by: dev-two <dev-two@example.com>\nCo-authored-by: dev-three <dev-three@example.com>",
            author: DEV_ONE,
            files: { "b.ts": "2\n" },
        });

        await extractAll({ cwd: cfg, noCache: true, now: NOW });

        withCache(cfg, (handle) => {
            const pairCredits = handle.db
                .select()
                .from(commitAuthors)
                .where(eq(commitAuthors.sha, shaOfFile(handle, "a.ts")))
                .all();
            expect(pairCredits).toHaveLength(2);
            expect(pairCredits.every((row) => row.weight === 0.5)).toBe(true);
            expect(
                pairCredits.reduce((sum, row) => sum + row.weight, 0)
            ).toBeCloseTo(1, 10);

            const mobCredits = handle.db
                .select()
                .from(commitAuthors)
                .where(eq(commitAuthors.sha, shaOfFile(handle, "b.ts")))
                .all();
            expect(mobCredits).toHaveLength(3);
            expect(
                mobCredits.reduce((sum, row) => sum + row.weight, 0)
            ).toBeCloseTo(1, 10);
        });
    } finally {
        cleanup([repo, cfg]);
    }
});

test("collapses aliases to one author and records unknown emails as provisional", async () => {
    const repo = initRepo("main");
    const cfg = writeConfig({
        repos: [{ name: "web-app", path: repo }],
        authors: {
            "dev-one": {
                emails: ["dev-one@example.com", "dev-one-alt@example.com"],
            },
        },
    });
    try {
        commit(repo, {
            message: "feat: a",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        commit(repo, {
            message: "feat: b",
            author: { name: "dev-one alt", email: "dev-one-alt@example.com" },
            files: { "b.ts": "2\n" },
        });
        commit(repo, {
            message: "feat: c",
            author: { name: "stranger", email: "stranger@example.com" },
            files: { "c.ts": "3\n" },
        });

        const result = await extractAll({ cwd: cfg, noCache: true, now: NOW });
        expect(result.unknownEmails).toContain("stranger@example.com");
        expect(result.unknownEmails).not.toContain("dev-one@example.com");
        expect(result.unknownEmails).not.toContain("dev-one-alt@example.com");

        withCache(cfg, (handle) => {
            const authorA = handle.db
                .select({ authorId: commits.authorId })
                .from(commits)
                .where(eq(commits.sha, shaOfFile(handle, "a.ts")))
                .get();
            const authorB = handle.db
                .select({ authorId: commits.authorId })
                .from(commits)
                .where(eq(commits.sha, shaOfFile(handle, "b.ts")))
                .get();
            expect(authorA?.authorId).toBe(authorB?.authorId ?? -1);

            const canonical = handle.db
                .select()
                .from(authors)
                .where(eq(authors.canonicalName, "dev-one"))
                .all();
            expect(canonical).toHaveLength(1);

            const provisional = handle.db
                .select()
                .from(authors)
                .where(eq(authors.canonicalName, "stranger@example.com"))
                .get();
            expect(provisional).toBeDefined();
        });
    } finally {
        cleanup([repo, cfg]);
    }
});

test("excludes matching files and flags migrations without excluding them", async () => {
    const repo = initRepo("main");
    const cfg = writeConfig({
        repos: [{ name: "web-app", path: repo }],
        exclude: ["**/*.lock"],
        migrationsPath: "**/migrations/**",
    });
    try {
        commit(repo, {
            message: "chore: setup",
            author: DEV_ONE,
            files: {
                "bun.lock": "lockfile\n",
                "src/app.ts": "app\n",
                "db/migrations/001_init.sql": "create table t;\n",
            },
        });

        await extractAll({ cwd: cfg, noCache: true, now: NOW });

        withCache(cfg, (handle) => {
            const lock = handle.db
                .select()
                .from(fileChanges)
                .where(eq(fileChanges.path, "bun.lock"))
                .all();
            expect(lock).toHaveLength(0);

            const app = handle.db
                .select()
                .from(fileChanges)
                .where(eq(fileChanges.path, "src/app.ts"))
                .get();
            expect(app?.isMigration).toBe(false);

            const migration = handle.db
                .select()
                .from(fileChanges)
                .where(eq(fileChanges.path, "db/migrations/001_init.sql"))
                .get();
            expect(migration).toBeDefined();
            expect(migration?.isMigration).toBe(true);
        });
    } finally {
        cleanup([repo, cfg]);
    }
});

test("skips an unchanged repo on a second run and leaves rows intact", async () => {
    const repo = initRepo("main");
    const cfg = writeConfig({ repos: [{ name: "web-app", path: repo }] });
    try {
        commit(repo, {
            message: "feat: a",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        commit(repo, {
            message: "feat: b",
            author: DEV_ONE,
            files: { "b.ts": "2\n" },
        });

        const first = await extractAll({ cwd: cfg, now: NOW });
        expect(first.repos[0]?.status).toBe("extracted");
        const before = withCache(cfg, (handle) => ({
            commits:
                handle.db.select({ value: count() }).from(commits).get()
                    ?.value ?? -1,
            files:
                handle.db.select({ value: count() }).from(fileChanges).get()
                    ?.value ?? -1,
        }));

        const second = await extractAll({ cwd: cfg, now: NOW });
        expect(second.repos[0]?.status).toBe("skipped");
        expect(second.repos[0]?.commitCount).toBe(0);
        const after = withCache(cfg, (handle) => ({
            commits:
                handle.db.select({ value: count() }).from(commits).get()
                    ?.value ?? -1,
            files:
                handle.db.select({ value: count() }).from(fileChanges).get()
                    ?.value ?? -1,
        }));
        expect(after).toEqual(before);
    } finally {
        cleanup([repo, cfg]);
    }
});

test("resolveDefaultBranch reads origin/HEAD when present", async () => {
    const source = initRepo("trunk");
    const clones = mkdtempSync(join(tmpdir(), "spanical-clone-"));
    try {
        commit(source, {
            message: "feat: a",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        const bare = join(clones, "bare.git");
        const work = join(clones, "work");
        git(clones, ["clone", "-q", "--bare", source, bare]);
        git(clones, ["clone", "-q", bare, work]);

        expect(await resolveDefaultBranch(work)).toBe("trunk");
    } finally {
        cleanup([source, clones]);
    }
});

test("resolveDefaultBranch falls back to main without an origin", async () => {
    const repo = initRepo("main");
    try {
        commit(repo, {
            message: "feat: a",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        expect(await resolveDefaultBranch(repo)).toBe("main");
    } finally {
        cleanup([repo]);
    }
});

test("resolveDefaultBranch falls back to master without an origin or main", async () => {
    const repo = initRepo("master");
    try {
        commit(repo, {
            message: "feat: a",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        expect(await resolveDefaultBranch(repo)).toBe("master");
    } finally {
        cleanup([repo]);
    }
});

test("resolveDefaultBranch prefers a config branch override and rejects a missing one", async () => {
    const repo = initRepo("main");
    try {
        commit(repo, {
            message: "feat: a",
            author: DEV_ONE,
            files: { "a.ts": "1\n" },
        });
        git(repo, ["branch", "develop"]);
        expect(await resolveDefaultBranch(repo, "develop")).toBe("develop");

        const { error } = await tryCatch(resolveDefaultBranch(repo, "ghost"));
        expect(error).toBeInstanceOf(ExtractError);
        if (error instanceof ExtractError) {
            expect(error.code).toBe(EXTRACT_ERROR_CODES.BRANCH_UNRESOLVED);
        }
    } finally {
        cleanup([repo]);
    }
});

test("tags rows by repo across multiple repos", async () => {
    const web = initRepo("main");
    const api = initRepo("main");
    const cfg = writeConfig({
        repos: [
            { name: "web-app", path: web },
            { name: "api", path: api },
        ],
    });
    try {
        commit(web, {
            message: "feat: web",
            author: DEV_ONE,
            files: { "web.ts": "1\n" },
        });
        commit(web, {
            message: "feat: web2",
            author: DEV_ONE,
            files: { "web2.ts": "2\n" },
        });
        commit(api, {
            message: "feat: api",
            author: DEV_TWO,
            files: { "api.ts": "1\n" },
        });

        const result = await extractAll({ cwd: cfg, noCache: true, now: NOW });
        expect(result.repos.map((repo) => repo.repo)).toEqual([
            "web-app",
            "api",
        ]);

        withCache(cfg, (handle) => {
            const webCommits = handle.db
                .select({ value: count() })
                .from(commits)
                .where(eq(commits.repo, "web-app"))
                .get();
            const apiCommits = handle.db
                .select({ value: count() })
                .from(commits)
                .where(eq(commits.repo, "api"))
                .get();
            expect(webCommits?.value).toBe(2);
            expect(apiCommits?.value).toBe(1);

            const webFiles = handle.db
                .select()
                .from(fileChanges)
                .where(eq(fileChanges.repo, "web-app"))
                .all();
            expect(webFiles.every((file) => file.repo === "web-app")).toBe(
                true
            );
        });
    } finally {
        cleanup([web, api, cfg]);
    }
});
