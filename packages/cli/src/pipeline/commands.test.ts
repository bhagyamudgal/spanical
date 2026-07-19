import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { count } from "drizzle-orm";
import type { TypeOf } from "@drizzle-team/brocli";
import { openCache } from "../cache/open";
import { sccSnapshots } from "../cache/schema";
import type { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import type { SpanicalUserConfig } from "../config/schema";
import { writeRendered } from "../render";
import { runChurn, runContributors, runSize } from "./commands";

const NOW = new Date("2026-07-19T12:00:00Z");
const SCC_ON_PATH = Bun.which("scc");

const DEV_ONE = { name: "dev-one", email: "dev-one@example.com" };
const DEV_TWO = { name: "dev-two", email: "dev-two@example.com" };

const APP_TS = `export function app(value: number): number {
    return value + 1;
}
`;
const UTIL_TS = `export function util(value: number): number {
    return value * 2;
}
`;
const API_TS = `export function api(value: number): string {
    return String(value);
}
`;

type Author = { name: string; email: string };
type RunFlags = Partial<TypeOf<typeof globalFlags>>;

function git(cwd: string, args: string[], env?: Record<string, string>): void {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        env: { ...process.env, ...env },
    });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`
        );
    }
}

function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-pipe-repo-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "ci"]);
    git(dir, ["config", "user.email", "ci@example.com"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    return dir;
}

function commitAt(
    dir: string,
    author: Author,
    isoDate: string,
    files: Record<string, string>,
    message: string
): void {
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
    }
    git(dir, ["add", "-A"]);
    git(
        dir,
        [
            "commit",
            "-q",
            "-m",
            message,
            `--author=${author.name} <${author.email}>`,
        ],
        { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate }
    );
}

function writeConfig(repoPath: string): { cfgDir: string; cfgFile: string } {
    const cfgDir = mkdtempSync(join(tmpdir(), "spanical-pipe-cfg-"));
    const config: SpanicalUserConfig = {
        repos: [{ name: "web-app", path: repoPath }],
        authors: {
            "dev-one": { emails: ["dev-one@example.com"] },
            "dev-two": { emails: ["dev-two@example.com"] },
        },
    };
    const source = `import { defineConfig } from "${import.meta.dir}/../public";\nexport default defineConfig(${JSON.stringify(config, null, 4)});\n`;
    const cfgFile = join(cfgDir, "spanical.config.ts");
    writeFileSync(cfgFile, source);
    return { cfgDir, cfgFile };
}

function buildFixture(): { repo: string; cfgDir: string; cfgFile: string } {
    const repo = initRepo();
    commitAt(
        repo,
        DEV_ONE,
        "2026-06-15T10:00:00Z",
        { "src/app.ts": APP_TS },
        "feat: app"
    );
    commitAt(
        repo,
        DEV_ONE,
        "2026-07-10T10:00:00Z",
        { "src/util.ts": UTIL_TS },
        "feat: util"
    );
    commitAt(
        repo,
        DEV_TWO,
        "2026-07-11T10:00:00Z",
        { "src/api.ts": API_TS },
        "feat: api"
    );
    const { cfgDir, cfgFile } = writeConfig(repo);
    return { repo, cfgDir, cfgFile };
}

function resolveRun(cfgFile: string, flags: RunFlags): Promise<ResolvedRun> {
    return resolveRunConfig({ flags: { config: cfgFile, ...flags }, now: NOW });
}

function tableRows(markdown: string): string[][] {
    return markdown
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .map((line) =>
            line
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim())
        );
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("runChurn renders the per-period table by default", async () => {
    const { repo, cfgDir, cfgFile } = buildFixture();
    try {
        const run = await resolveRun(cfgFile, {
            since: "2026-06-01",
            period: "month",
            format: "md",
        });
        const markdown = await runChurn(run, cfgFile, NOW);

        expect(markdown).toContain("Period");
        expect(markdown).toContain("Commits");
        expect(markdown).toContain("Migrations");
        expect(markdown).not.toContain("Author");

        const rows = tableRows(markdown);
        const june = rows.find((cells) => cells[0] === "2026-06");
        const july = rows.find((cells) => cells[0] === "2026-07");
        expect(june?.[1]).toBe("1");
        expect(july?.[1]).toBe("2");
    } finally {
        cleanup([repo, cfgDir]);
    }
});

test("runChurn --by dev switches to the per-dev table with flag markers", async () => {
    const { repo, cfgDir, cfgFile } = buildFixture();
    try {
        const run = await resolveRun(cfgFile, {
            by: "dev",
            since: "2026-06-01",
            period: "month",
            format: "md",
        });
        const markdown = await runChurn(run, cfgFile, NOW);

        expect(markdown).toContain("Period");
        expect(markdown).toContain("Author");
        expect(markdown).toContain("(volume)");
        expect(markdown).toContain("(signal)");
        expect(markdown).toContain("dev-one");
        expect(markdown).toContain("dev-two");
    } finally {
        cleanup([repo, cfgDir]);
    }
});

test("runContributors shows one row per dev over the whole window", async () => {
    const { repo, cfgDir, cfgFile } = buildFixture();
    try {
        const run = await resolveRun(cfgFile, {
            since: "2026-06-01",
            format: "md",
        });
        const markdown = await runContributors(run, cfgFile, NOW);

        expect(markdown).toContain("Author");
        expect(markdown).toContain("(volume)");
        expect(markdown).toContain("(signal)");

        const rows = tableRows(markdown);
        expect(rows[0]?.[0]).toBe("Author");

        const devOne = rows.find((cells) => cells[0] === "dev-one");
        const devTwo = rows.find((cells) => cells[0] === "dev-two");
        expect(devOne?.[1]).toBe("2");
        expect(devTwo?.[1]).toBe("1");

        const devRows = rows.filter(
            (cells) => cells[0] === "dev-one" || cells[0] === "dev-two"
        );
        expect(devRows).toHaveLength(2);
    } finally {
        cleanup([repo, cfgDir]);
    }
});

test.skipIf(SCC_ON_PATH === null)(
    "runSize records monthly snapshots and lists the months",
    async () => {
        const { repo, cfgDir, cfgFile } = buildFixture();
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                format: "md",
            });
            const markdown = await runSize(run, cfgFile, NOW);

            expect(markdown).toContain("Month");
            expect(markdown).toContain("2026-06");
            expect(markdown).toContain("2026-07");

            const handle = openCache({ configPath: cfgFile });
            try {
                const total =
                    handle.db
                        .select({ value: count() })
                        .from(sccSnapshots)
                        .get()?.value ?? 0;
                expect(total).toBeGreaterThan(0);
            } finally {
                handle.sqlite.close();
            }
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test("json format returns parseable data that writeRendered persists verbatim", async () => {
    const { repo, cfgDir, cfgFile } = buildFixture();
    try {
        const run = await resolveRun(cfgFile, {
            by: "file",
            since: "2026-06-01",
            period: "month",
            format: "json",
        });
        const json = await runChurn(run, cfgFile, NOW);

        const parsed = JSON.parse(json);
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed).toHaveLength(2);

        const outFile = join(cfgDir, "churn.json");
        writeRendered(json, outFile);
        expect(readFileSync(outFile, "utf8").trimEnd()).toBe(json);
    } finally {
        cleanup([repo, cfgDir]);
    }
});
