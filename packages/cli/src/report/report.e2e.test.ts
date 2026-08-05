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
import { openCache } from "../cache/open";
import { githubSyncs, reviews, tickets } from "../cache/schema";
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

function writeConfig(
    repoPath: string,
    ticketsConfig?: SpanicalUserConfig["tickets"]
): string {
    const cfgDir = mkdtempSync(join(tmpdir(), "spanical-report-cfg-"));
    const config: SpanicalUserConfig = {
        repos: [{ name: "web-app", path: repoPath }],
        authors: {
            "dev-one": {
                emails: ["dev-one@example.com"],
                github: ["dev-one-gh"],
            },
            "dev-two": {
                emails: ["dev-two@example.com"],
                github: ["dev-two-gh"],
            },
        },
        tickets: ticketsConfig,
    };
    const source = `import { defineConfig } from "${import.meta.dir}/../public";\nexport default defineConfig(${JSON.stringify(config, null, 4)});\n`;
    const cfgFile = join(cfgDir, "spanical.config.ts");
    writeFileSync(cfgFile, source);
    return cfgFile;
}

function buildFixture(ticketsConfig?: SpanicalUserConfig["tickets"]): {
    repo: string;
    cfgFile: string;
} {
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
    return { repo, cfgFile: writeConfig(repo, ticketsConfig) };
}

// Seeded straight into the cache the run will open: the report must read the
// ticket layer without a network call or a real credential ever being involved.
function seedTicketCache(cfgFile: string): void {
    const handle = openCache({ configPath: cfgFile });
    try {
        handle.db
            .insert(githubSyncs)
            .values({
                repo: "web-app",
                slug: "acme/web-app",
                since: "2026-07-01",
                syncedThrough: Date.UTC(2026, 6, 15),
                issuesSyncedThrough: Date.UTC(2026, 6, 15),
                syncedAt: Date.UTC(2026, 6, 15),
            })
            .run();
        handle.db
            .insert(tickets)
            .values({
                nodeId: "pr-1",
                repo: "web-app",
                kind: "pr",
                number: 1,
                title: "feat: util",
                author: "dev-one-gh",
                authorIsBot: false,
                assignee: "dev-one-gh",
                assigneeIsBot: false,
                closedBy: "dev-one-gh",
                closedByIsBot: false,
                createdAt: Date.UTC(2026, 6, 10),
                closedAt: Date.UTC(2026, 6, 11),
                mergedAt: Date.UTC(2026, 6, 11),
                updatedAt: Date.UTC(2026, 6, 11),
                state: "MERGED",
                reopenedCount: 0,
                additions: 12,
                deletions: 3,
            })
            .run();
        handle.db
            .insert(reviews)
            .values({
                nodeId: "review-1",
                prNodeId: "pr-1",
                reviewer: "dev-two-gh",
                reviewerIsBot: false,
                submittedAt: Date.UTC(2026, 6, 11),
                requestedAt: Date.UTC(2026, 6, 10),
                state: "APPROVED",
            })
            .run();
    } finally {
        handle.sqlite.close();
    }
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
            expect(content).toContain("Top hotspots (refactor shortlist)");
            expect(content).toContain("Bus-factor warnings:");
            expect(content).toContain("## Timeline");
            expect(content).toContain("## Contributors");
            expect(content).toContain("## Hotspots");
            expect(content).toContain("## Ownership & bus-factor");
            expect(content).toContain("## Size & complexity");
            expect(content).toContain("## Per-repo appendix");
            expect(content).toContain("### web-app");

            expect(terminal).toContain("Top hotspots (refactor shortlist)");
            expect(terminal).toContain("Bus-factor warnings:");
            expect(terminal).toContain("Full report ->");
            expect(terminal).not.toContain("| Author |");
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

const TICKETS_CONFIG: SpanicalUserConfig["tickets"] = {
    source: "github",
    github: { token: "env:GITHUB_TOKEN", includeIssues: false },
};

test.skipIf(SCC_ON_PATH === null)(
    "runReport omits the ticket sections when no token is exported",
    async () => {
        const { repo, cfgFile } = buildFixture(TICKETS_CONFIG);
        const cfgDir = dirname(cfgFile);
        const outFile = join(cfgDir, "engineering-report.md");
        try {
            seedTicketCache(cfgFile);
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                out: outFile,
            });
            await withToken(null, () => runReport(run, cfgFile, NOW));

            const content = readFileSync(outFile, "utf8");
            expect(content).not.toContain("## Tickets");
            expect(content).not.toContain("## Reviews");
            expect(content).not.toContain("#### Tickets");
            expect(content).not.toContain("#### Reviews");
            expect(content).not.toContain("Review coverage");
            expect(content).not.toContain("the GitHub refresh did not finish");

            for (const heading of [
                "## Activity by period",
                "## Timeline",
                "## Contributors",
                "## Hotspots",
                "## Ownership & bus-factor",
                "## Size & complexity",
                "## Migrations",
                "## Per-repo appendix",
            ]) {
                expect(content).toContain(heading);
            }
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runReport renders the cached ticket layer and names a failed refresh",
    async () => {
        const { repo, cfgFile } = buildFixture(TICKETS_CONFIG);
        const cfgDir = dirname(cfgFile);
        const outFile = join(cfgDir, "engineering-report.md");
        try {
            seedTicketCache(cfgFile);
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                out: outFile,
            });
            const { terminal } = await withToken("test-token", () =>
                runReport(run, cfgFile, NOW)
            );

            expect(terminal).toContain("Full report ->");
            const content = readFileSync(outFile, "utf8");

            const combined = content.slice(
                content.indexOf("## Tickets"),
                content.indexOf("## Hotspots")
            );
            expect(combined).toContain("### Ticket flow");
            expect(combined).toContain("## Reviews");
            expect(combined).toContain("### Review load");
            expect(combined).toContain("dev-one");
            expect(combined).toContain(
                "Review coverage: 1 of 1 merged pull request(s) carry a review (100%)"
            );

            const appendix = content.slice(
                content.indexOf("## Per-repo appendix")
            );
            expect(appendix).toContain("#### Tickets");
            expect(appendix).toContain("#### Reviews");

            expect(content).toContain(
                "Warning: the GitHub refresh did not finish, so the ticket data here may be missing anything that changed since the last complete sync"
            );
            expect(content).toContain('has no "origin" remote');
            expect(content).toContain(
                "Note: the ticket cache was synced from a later date than this window starts — web-app (2026-07-01)"
            );
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
