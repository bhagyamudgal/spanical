import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { openCache } from "../cache/open";
import { fileChanges } from "../cache/schema";
import type { SpanicalUserConfig } from "../config/schema";

const INDEX_PATH = join(import.meta.dir, "..", "index.ts");
const PUBLIC_IMPORT = `${import.meta.dir}/../public`;
const SCC_ON_PATH = Bun.which("scc");
const REPORT_FILE_PATTERN = /^spanical-report-.*\.md$/;
const OUTSIDE_GIT_REPOSITORY_MARKER = "not inside a git repository";

const DEV_ONE = { name: "dev-one", email: "dev-one@example.com" };
const DEV_ONE_ALT = { name: "dev-one-alt", email: "dev-one-alt@example.com" };
const DEV_TWO = { name: "dev-two", email: "dev-two@example.com" };

const devRowsSchema = z.array(z.object({ author: z.string() }));
const churnRowsSchema = z.array(z.object({ throughput: z.number() }));

type Author = { name: string; email: string };

type CliResult = { exitCode: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): void {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`
        );
    }
}

function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-run-repo-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "ci"]);
    git(dir, ["config", "user.email", "ci@example.com"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    return dir;
}

function commit(
    dir: string,
    author: Author,
    files: Record<string, string>,
    message: string
): void {
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
    }
    git(dir, ["add", "-A"]);
    git(dir, [
        "commit",
        "-q",
        "-m",
        message,
        `--author=${author.name} <${author.email}>`,
    ]);
}

function writeConfig(dir: string, config: SpanicalUserConfig): void {
    const source = `import { defineConfig } from "${PUBLIC_IMPORT}";\nexport default defineConfig(${JSON.stringify(config, null, 4)});\n`;
    writeFileSync(join(dir, "spanical.config.ts"), source);
}

function runCli(cwd: string, args: string[]): CliResult {
    const result = Bun.spawnSync(["bun", INDEX_PATH, ...args], {
        cwd,
        env: process.env,
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

function distinctAuthors(result: CliResult): string[] {
    const rows = devRowsSchema.parse(JSON.parse(result.stdout));
    return [...new Set(rows.map((row) => row.author))].sort();
}

// A config-less run always writes its "default settings" note to stderr, so only
// a failing run reports stderr — a passing one would drown in the note, and a
// blanked stderr would hide the diagnostic for an unrelated failure.
function expectRepoFlagRun(subcommand: string, result: CliResult): void {
    const hasFailed =
        result.exitCode !== 0 ||
        result.stderr.includes(OUTSIDE_GIT_REPOSITORY_MARKER);
    expect({
        subcommand,
        exitCode: result.exitCode,
        stderr: hasFailed ? result.stderr : "",
    }).toEqual({ subcommand, exitCode: 0, stderr: "" });
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("churn runs in a git repository that has no config file", () => {
    const repo = initRepo();
    try {
        commit(repo, DEV_ONE, { "a.ts": "1\n" }, "feat: a");

        const result = runCli(repo, [
            "churn",
            "--by",
            "dev",
            "--format",
            "json",
        ]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain("with default settings");
        expect(distinctAuthors(result)).toEqual([DEV_ONE.email]);
    } finally {
        cleanup([repo]);
    }
});

test("a config at the repo root is used from a subdirectory", () => {
    const repo = initRepo();
    try {
        commit(repo, DEV_ONE, { "packages/web/a.ts": "1\n" }, "feat: a");
        commit(repo, DEV_ONE_ALT, { "packages/web/b.ts": "2\n" }, "feat: b");
        writeConfig(repo, {
            repos: [{ name: "web-app", path: repo }],
            authors: {
                "dev-one": { emails: [DEV_ONE.email, DEV_ONE_ALT.email] },
            },
        });

        const subdirectory = join(repo, "packages", "web");
        const result = runCli(subdirectory, [
            "churn",
            "--by",
            "dev",
            "--format",
            "json",
        ]);

        expect(result.exitCode).toBe(0);
        expect(distinctAuthors(result)).toEqual(["dev-one"]);
        expect(result.stderr).not.toContain("default settings");
        expect(existsSync(join(subdirectory, ".spanical"))).toBe(false);
        expect(existsSync(join(repo, ".spanical"))).toBe(true);
    } finally {
        cleanup([repo]);
    }
});

test("--repo works from a directory that is not a git repository", () => {
    const repo = initRepo();
    const elsewhere = mkdtempSync(join(tmpdir(), "spanical-run-plain-"));
    try {
        commit(repo, DEV_ONE, { "a.ts": "1\n" }, "feat: a");

        const result = runCli(elsewhere, [
            "churn",
            "--repo",
            repo,
            "--by",
            "dev",
            "--format",
            "json",
        ]);

        expectRepoFlagRun("churn", result);
        expect(distinctAuthors(result)).toEqual([DEV_ONE.email]);
    } finally {
        cleanup([repo, elsewhere]);
    }
});

test.skipIf(SCC_ON_PATH === null)(
    "--repo works from a directory that is not a git repository for scc-backed subcommands",
    () => {
        const repo = initRepo();
        const elsewhere = mkdtempSync(join(tmpdir(), "spanical-run-plain-"));
        try {
            commit(
                repo,
                DEV_ONE,
                { "src/a.ts": "export const a = 1;\n" },
                "feat: a"
            );

            for (const subcommand of [
                "contributors",
                "ownership",
                "hotspots",
                "report",
            ]) {
                expectRepoFlagRun(
                    subcommand,
                    runCli(elsewhere, [subcommand, "--repo", repo])
                );
            }
        } finally {
            cleanup([repo, elsewhere]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "report runs in a git repository that has no config file",
    () => {
        const repo = initRepo();
        try {
            commit(
                repo,
                DEV_ONE,
                { "src/a.ts": "export const a = 1;\n" },
                "feat: a"
            );

            const result = runCli(repo, ["report"]);

            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("Full report ->");
            expect(
                readdirSync(repo).filter((name) =>
                    REPORT_FILE_PATTERN.test(name)
                ).length
            ).toBeGreaterThan(0);
        } finally {
            cleanup([repo]);
        }
    }
);

test("--repo scopes a run started from a repository with no config file", () => {
    const cwdRepo = initRepo();
    const otherRepo = initRepo();
    try {
        commit(cwdRepo, DEV_ONE, { "a.ts": "1\n" }, "feat: a");
        commit(otherRepo, DEV_TWO, { "b.ts": "2\n" }, "feat: b");

        // Warm the cache with the surrounding repo first, so the scoped run has
        // to exclude rows that are actually present rather than merely absent.
        const warmup = runCli(cwdRepo, [
            "churn",
            "--by",
            "dev",
            "--format",
            "json",
        ]);
        expect(distinctAuthors(warmup)).toEqual([DEV_ONE.email]);

        const result = runCli(cwdRepo, [
            "churn",
            "--repo",
            otherRepo,
            "--by",
            "dev",
            "--format",
            "json",
        ]);

        expect(result.exitCode).toBe(0);
        expect(distinctAuthors(result)).toEqual([DEV_TWO.email]);
    } finally {
        cleanup([cwdRepo, otherRepo]);
    }
});

test("--exclude re-extracts a cached repo and changes churn totals", () => {
    const repo = initRepo();
    try {
        commit(
            repo,
            DEV_ONE,
            {
                "src/included.ts": "1\n",
                "src/generated/excluded.ts": "2\n",
            },
            "feat: add generated source"
        );
        writeConfig(repo, {
            repos: [{ name: "web-app", path: repo }],
            exclude: [],
        });

        const warmup = runCli(repo, ["churn", "--format", "json"]);
        const excluded = runCli(repo, [
            "churn",
            "--exclude",
            "**/generated/**",
            "--format",
            "json",
        ]);
        expect(warmup.exitCode).toBe(0);
        expect(excluded.exitCode).toBe(0);

        const warmupRows = churnRowsSchema.parse(JSON.parse(warmup.stdout));
        const excludedRows = churnRowsSchema.parse(JSON.parse(excluded.stdout));
        const cache = openCache({ cwd: repo });
        const storedPaths = cache.db
            .select({ path: fileChanges.path })
            .from(fileChanges)
            .all()
            .map((row) => row.path);
        cache.sqlite.close();

        expect({
            storedPaths,
            warmupThroughput: warmupRows.reduce(
                (total, row) => total + row.throughput,
                0
            ),
            excludedThroughput: excludedRows.reduce(
                (total, row) => total + row.throughput,
                0
            ),
        }).toEqual({
            storedPaths: ["src/included.ts"],
            warmupThroughput: 2,
            excludedThroughput: 1,
        });
    } finally {
        cleanup([repo]);
    }
});

test("tickets rejects --period rather than accepting it and ignoring it", () => {
    const repo = initRepo();
    try {
        commit(repo, DEV_ONE, { "a.ts": "1\n" }, "feat: a");

        const result = runCli(repo, ["tickets", "--period", "month"]);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--period is not supported by tickets");
        // The rejection has to land before the token and config preconditions,
        // so the flag is named rather than a missing credential.
        expect(result.stderr).not.toContain("GITHUB_TOKEN");
        expect(result.stderr).not.toContain("No tickets section");
    } finally {
        cleanup([repo]);
    }
});

test("adding an authors entry re-attributes an extracted repo without --no-cache", () => {
    const repo = initRepo();
    try {
        commit(repo, DEV_ONE, { "a.ts": "1\n" }, "feat: a");
        commit(repo, DEV_ONE_ALT, { "b.ts": "2\n" }, "feat: b");
        writeConfig(repo, { repos: [{ name: "web-app", path: repo }] });

        const first = runCli(repo, [
            "churn",
            "--by",
            "dev",
            "--format",
            "json",
        ]);
        expect(first.exitCode).toBe(0);
        expect(distinctAuthors(first)).toEqual(
            [DEV_ONE.email, DEV_ONE_ALT.email].sort()
        );

        writeConfig(repo, {
            repos: [{ name: "web-app", path: repo }],
            authors: {
                "dev-one": { emails: [DEV_ONE.email, DEV_ONE_ALT.email] },
            },
        });

        const second = runCli(repo, [
            "churn",
            "--by",
            "dev",
            "--format",
            "json",
        ]);
        expect(second.exitCode).toBe(0);
        expect(distinctAuthors(second)).toEqual(["dev-one"]);
    } finally {
        cleanup([repo]);
    }
});
