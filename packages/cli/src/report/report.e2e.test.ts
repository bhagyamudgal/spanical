import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TypeOf } from "@drizzle-team/brocli";
import type { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import { runReport } from "../commands/report";
import type { SpanicalUserConfig } from "../config/schema";

const NOW = new Date("2026-07-19T12:00:00Z");
const SCC_ON_PATH = Bun.which("scc");
const INDEX_PATH = join(import.meta.dir, "..", "index.ts");
const REPORT_FILE_PATTERN = /^spanical-report-.*\.md$/;

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
    const dir = mkdtempSync(join(tmpdir(), "spanical-report-repo-"));
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

function writeConfig(repoPath: string): string {
    const cfgDir = mkdtempSync(join(tmpdir(), "spanical-report-cfg-"));
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
    return cfgFile;
}

function buildFixture(): { repo: string; cfgFile: string } {
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
    return { repo, cfgFile: writeConfig(repo) };
}

function resolveRun(cfgFile: string, flags: RunFlags): Promise<ResolvedRun> {
    return resolveRunConfig({ flags: { config: cfgFile, ...flags }, now: NOW });
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

test.skipIf(SCC_ON_PATH === null)(
    "runReport writes a Markdown artifact and a summary-only terminal view",
    async () => {
        const { repo, cfgFile } = buildFixture();
        const cfgDir = dirname(cfgFile);
        const outFile = join(cfgDir, "engineering-report.md");
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                out: outFile,
            });
            const { terminal, artifactPath } = await runReport(
                run,
                cfgFile,
                NOW
            );

            expect(artifactPath).toBe(outFile);
            expect(existsSync(artifactPath)).toBe(true);

            const content = readFileSync(artifactPath, "utf8");
            expect(content).toContain("# Engineering report");
            expect(content).toContain("Net growth");
            expect(content).toContain("## Contributors");

            expect(terminal).toContain("Full report ->");
            expect(terminal).not.toContain("| Author |");
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "report command writes a default-named artifact and prints the pointer",
    () => {
        const { repo, cfgFile } = buildFixture();
        const cfgDir = dirname(cfgFile);
        const outDir = mkdtempSync(join(tmpdir(), "spanical-report-out-"));
        try {
            const result = Bun.spawnSync(
                ["bun", INDEX_PATH, "report", "--config", cfgFile],
                { cwd: outDir, env: process.env }
            );

            expect(result.exitCode).toBe(0);
            expect(result.stdout.toString()).toContain("Full report ->");

            const reports = readdirSync(outDir).filter((name) =>
                REPORT_FILE_PATTERN.test(name)
            );
            expect(reports.length).toBeGreaterThan(0);
        } finally {
            cleanup([repo, cfgDir, outDir]);
        }
    }
);
