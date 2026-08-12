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
import { and, count, eq } from "drizzle-orm";
import type { TypeOf } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import { openCache } from "../cache/open";
import { sccSnapshots } from "../cache/schema";
import type { globalFlags } from "../cli/global-flags";
import { resolveRunConfig, type ResolvedRun } from "../cli/resolve-run";
import type { SpanicalUserConfig } from "../config/schema";
import { writeRendered } from "../render";
import {
    runChurn,
    runContributors,
    runHotspots,
    runOwnership,
    runReviews,
    runSize,
    runTickets,
    runTimeline,
} from "./commands";

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
const LOGIC_TS = `export function classify(value: number): string {
    if (value > 100) {
        return "huge";
    }
    if (value > 10) {
        return "big";
    }
    for (let index = 0; index < value; index += 1) {
        if (index % 2 === 0) {
            continue;
        }
    }
    return value > 0 ? "small" : "none";
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

function boundaryComplexity(
    handle: ReturnType<typeof openCache>,
    month: string,
    path: string
): number {
    const row = handle.db
        .select({ complexity: sccSnapshots.complexity })
        .from(sccSnapshots)
        .where(
            and(
                eq(sccSnapshots.repo, "web-app"),
                eq(sccSnapshots.isBoundary, true),
                eq(sccSnapshots.month, month),
                eq(sccSnapshots.path, path)
            )
        )
        .get();
    if (row === undefined) {
        throw new Error(`No boundary snapshot for ${path} in ${month}`);
    }
    return row.complexity;
}

function complexityAddedFor(json: string, author: string): number {
    const parsed: unknown = JSON.parse(json);
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("complexity" in parsed)
    ) {
        throw new Error("Expected complexity in json output");
    }
    const { complexity } = parsed;
    if (!Array.isArray(complexity)) {
        throw new Error("Expected a complexity array");
    }
    for (const row of complexity) {
        if (
            typeof row === "object" &&
            row !== null &&
            "author" in row &&
            row.author === author &&
            "complexityAdded" in row &&
            typeof row.complexityAdded === "number"
        ) {
            return row.complexityAdded;
        }
    }
    throw new Error(`No complexity row for ${author}`);
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
    tickets?: SpanicalUserConfig["tickets"],
    additionalRepos: SpanicalUserConfig["repos"] = []
): { cfgDir: string; cfgFile: string } {
    const cfgDir = mkdtempSync(join(tmpdir(), "spanical-pipe-cfg-"));
    const config: SpanicalUserConfig = {
        repos: [{ name: "web-app", path: repoPath }, ...additionalRepos],
        authors: {
            "dev-one": { emails: ["dev-one@example.com"] },
            "dev-two": { emails: ["dev-two@example.com"] },
        },
        tickets,
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

function buildNoSccFixture(): {
    repo: string;
    cfgDir: string;
    cfgFile: string;
} {
    const repo = initRepo();
    commitAt(
        repo,
        DEV_ONE,
        "2026-07-10T10:00:00Z",
        { ".gitkeep": "" },
        "chore: keep empty repository"
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

test.skipIf(SCC_ON_PATH === null)(
    "runContributors renders the dev-volume table and the complexity table",
    async () => {
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
            expect(markdown).toContain("Complexity removed");
            expect(markdown).toContain("Hotspot share");
            expect(markdown).toContain("approximate");

            const rows = tableRows(markdown);
            expect(rows[0]?.[0]).toBe("Author");

            const devOne = rows.find((cells) => cells[0] === "dev-one");
            const devTwo = rows.find((cells) => cells[0] === "dev-two");
            expect(devOne?.[1]).toBe("2");
            expect(devTwo?.[1]).toBe("1");
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runContributors baselines the pre-window month so first-month complexity is not credited as added",
    async () => {
        const repo = initRepo();
        commitAt(
            repo,
            DEV_ONE,
            "2026-05-15T10:00:00Z",
            { "src/logic.ts": LOGIC_TS },
            "feat: seed complex logic before the window"
        );
        commitAt(
            repo,
            DEV_TWO,
            "2026-06-15T10:00:00Z",
            { "src/logic.ts": `${LOGIC_TS}// bump june\n` },
            "chore: neutral june edit"
        );
        commitAt(
            repo,
            DEV_TWO,
            "2026-07-10T10:00:00Z",
            { "src/logic.ts": `${LOGIC_TS}// bump june\n// bump july\n` },
            "chore: neutral july edit"
        );
        const { cfgDir, cfgFile } = writeConfig(repo);
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                format: "json",
            });
            const json = await runContributors(run, cfgFile, NOW);

            const handle = openCache({ configPath: cfgFile });
            let juneComplexity: number;
            try {
                juneComplexity = boundaryComplexity(
                    handle,
                    "2026-06",
                    "src/logic.ts"
                );
            } finally {
                handle.sqlite.close();
            }

            expect(juneComplexity).toBeGreaterThan(0);
            expect(complexityAddedFor(json, "dev-two")).toBeLessThan(
                juneComplexity
            );
            expect(complexityAddedFor(json, "dev-two")).toBe(0);
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

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

test.skipIf(SCC_ON_PATH === null)(
    "runSize reports zero for a measured boundary without code data",
    async () => {
        const { repo, cfgDir, cfgFile } = buildNoSccFixture();
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                format: "md",
            });

            const markdown = await runSize(run, cfgFile, NOW);
            expect(markdown).toContain("| 2026-07 | 0 | 0 |  |");
            expect(markdown).not.toContain("No size trend:");
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runSize excludes repository history after an open window's end",
    async () => {
        const { repo, cfgDir, cfgFile } = buildFixture();
        try {
            const run = await resolveRun(cfgFile, {
                until: "2026-06-01",
                format: "md",
            });

            expect(await runSize(run, cfgFile, NOW)).toBe(
                [
                    "No size trend: no monthly boundary SCC snapshot data was available for the selected repositories.",
                    "Note: no commit at or before the window end was available for web-app; that repository was not measured.",
                ].join("\n\n")
            );
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runSize snapshots a partial final month at the requested window end",
    async () => {
        const repo = initRepo();
        commitAt(
            repo,
            DEV_ONE,
            "2026-06-10T10:00:00Z",
            { "src/app.ts": APP_TS },
            "feat: app before cutoff"
        );
        commitAt(
            repo,
            DEV_TWO,
            "2026-06-20T10:00:00Z",
            { "src/util.ts": UTIL_TS },
            "feat: util after cutoff"
        );
        const { cfgDir, cfgFile } = writeConfig(repo);
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                until: "2026-06-15",
                format: "json",
            });

            await runSize(run, cfgFile, NOW);

            const handle = openCache({ configPath: cfgFile });
            try {
                const paths = handle.db
                    .select({ path: sccSnapshots.path })
                    .from(sccSnapshots)
                    .where(
                        and(
                            eq(sccSnapshots.repo, "web-app"),
                            eq(sccSnapshots.month, "2026-06"),
                            eq(sccSnapshots.isBoundary, true)
                        )
                    )
                    .all()
                    .map((row) => row.path);
                expect(paths).toEqual(["src/app.ts"]);
            } finally {
                handle.sqlite.close();
            }
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runSize discloses a selected repository without a window-end commit",
    async () => {
        const measuredRepo = initRepo();
        const unmeasuredRepo = initRepo();
        commitAt(
            measuredRepo,
            DEV_ONE,
            "2026-06-10T10:00:00Z",
            { "src/app.ts": APP_TS },
            "feat: measured app"
        );
        commitAt(
            unmeasuredRepo,
            DEV_TWO,
            "2026-08-01T10:00:00Z",
            { "src/api.ts": API_TS },
            "feat: api after cutoff"
        );
        const { cfgDir, cfgFile } = writeConfig(measuredRepo, undefined, [
            { name: "api", path: unmeasuredRepo },
        ]);
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                until: "2026-07-15",
                format: "md",
            });

            const markdown = await runSize(run, cfgFile, NOW);

            expect(markdown).toContain("| Month | Total code |");
            expect(markdown).toContain(
                "Note: no commit at or before the window end was available for api; that repository was not measured."
            );
        } finally {
            cleanup([measuredRepo, unmeasuredRepo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runHotspots names every eligibility rule when no files qualify",
    async () => {
        const { repo, cfgDir, cfgFile } = buildNoSccFixture();
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                format: "table",
            });

            expect(await runHotspots(run, cfgFile, NOW)).toBe(
                "No hotspots: no eligible non-binary, non-migration file both changed in the selected window and had at least 50 code lines in its window-end SCC snapshot."
            );
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "runOwnership explains when no surviving blame rows are available",
    async () => {
        const { repo, cfgDir, cfgFile } = buildNoSccFixture();
        try {
            const run = await resolveRun(cfgFile, {
                since: "2026-06-01",
                format: "md",
            });

            expect(await runOwnership(run, cfgFile, NOW)).toContain(
                "No ownership data: no surviving blame rows were available for files with at least 50 code lines."
            );
        } finally {
            cleanup([repo, cfgDir]);
        }
    }
);

test("runTimeline explains why an open-start history has no periods", async () => {
    const { repo, cfgDir, cfgFile } = buildFixture();
    try {
        const run = await resolveRun(cfgFile, {
            until: "2026-07-18",
            format: "md",
        });

        expect(await runTimeline(run, cfgFile, NOW)).toBe(
            "No timeline periods: an open-start history window has no bounded periods to plot."
        );
    } finally {
        cleanup([repo, cfgDir]);
    }
});

test("runTickets refuses to run without a token and names the variable", async () => {
    const repo = initRepo();
    const { cfgDir, cfgFile } = writeConfig(repo, {
        source: "github",
        github: { token: "env:GITHUB_TOKEN", includeIssues: false },
    });
    const configuredToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
        const run = await resolveRun(cfgFile, { since: "2026-06-01" });
        const { error } = await tryCatch(runTickets(run, cfgFile, NOW));

        expect(error).not.toBeNull();
        expect(error?.message).toContain("GITHUB_TOKEN is not set");
        expect(error?.message).not.toContain("at ");
    } finally {
        if (configuredToken !== undefined) {
            process.env.GITHUB_TOKEN = configuredToken;
        }
        cleanup([repo, cfgDir]);
    }
});

test("runReviews refuses to run without a token and names the variable", async () => {
    const repo = initRepo();
    const { cfgDir, cfgFile } = writeConfig(repo, {
        source: "github",
        github: { token: "env:GITHUB_TOKEN", includeIssues: false },
    });
    const configuredToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
        const run = await resolveRun(cfgFile, { since: "2026-06-01" });
        const { error } = await tryCatch(runReviews(run, cfgFile, NOW));

        expect(error).not.toBeNull();
        expect(error?.message).toContain("GITHUB_TOKEN is not set");
    } finally {
        if (configuredToken !== undefined) {
            process.env.GITHUB_TOKEN = configuredToken;
        }
        cleanup([repo, cfgDir]);
    }
});

test("runReviews explains an unconfigured ticket layer before asking for a token", async () => {
    const repo = initRepo();
    const { cfgDir, cfgFile } = writeConfig(repo);
    try {
        const run = await resolveRun(cfgFile, { since: "2026-06-01" });
        const { error } = await tryCatch(runReviews(run, cfgFile, NOW));

        expect(error?.message).toContain("No tickets section");
    } finally {
        cleanup([repo, cfgDir]);
    }
});

test("runTickets explains an unconfigured ticket layer before asking for a token", async () => {
    const repo = initRepo();
    const { cfgDir, cfgFile } = writeConfig(repo);
    try {
        const run = await resolveRun(cfgFile, { since: "2026-06-01" });
        const { error } = await tryCatch(runTickets(run, cfgFile, NOW));

        expect(error?.message).toContain("No tickets section");
    } finally {
        cleanup([repo, cfgDir]);
    }
});

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
