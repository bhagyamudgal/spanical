import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { SpanicalUserConfig } from "../config/schema";

const INDEX_PATH = join(import.meta.dir, "..", "index.ts");
const PUBLIC_IMPORT = `${import.meta.dir}/../public`;
const SCC_ON_PATH = Bun.which("scc");

const DEV_ONE = { name: "dev-one", email: "dev-one@example.com" };
const DEV_TWO = { name: "dev-two", email: "dev-two@example.com" };

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
    const dir = mkdtempSync(join(tmpdir(), "spanical-rework-repo-"));
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

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

const contributorRowsSchema = z.object({
    contributors: z.array(
        z.object({
            author: z.string(),
            reworkLines: z.number().nullable(),
        })
    ),
});

test.skipIf(SCC_ON_PATH === null)(
    "contributors charges young deletions to the line's original author",
    () => {
        const repo = initRepo();
        try {
            writeConfig(repo, {
                repos: [{ name: "web-app", path: repo }],
                authors: {
                    "dev-one": { emails: [DEV_ONE.email] },
                    "dev-two": { emails: [DEV_TWO.email] },
                },
            });
            commit(
                repo,
                DEV_ONE,
                {
                    "src/a.ts":
                        ["one", "two", "three", "four", "five"].join("\n") +
                        "\n",
                },
                "feat: five lines by dev-one"
            );
            // dev-two keeps two of dev-one's lines and deletes three, so the
            // three dead lines are rework charged to dev-one, not dev-two.
            commit(
                repo,
                DEV_TWO,
                { "src/a.ts": ["one", "two", "six"].join("\n") + "\n" },
                "refactor: trim to essentials"
            );

            const result = runCli(repo, ["contributors", "--format", "json"]);

            expect(result.exitCode).toBe(0);
            const parsed = contributorRowsSchema.parse(
                JSON.parse(result.stdout)
            );
            const byAuthor = new Map(
                parsed.contributors.map((row) => [row.author, row.reworkLines])
            );
            expect(byAuthor.get("dev-one")).toBe(3);
            expect(byAuthor.get("dev-two")).toBe(0);
        } finally {
            cleanup([repo]);
        }
    }
);
