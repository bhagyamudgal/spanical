import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openCache, type CacheDatabase } from "../cache/open";
import { sccSnapshots } from "../cache/schema";
import { resolveRunConfig } from "../cli/resolve-run";
import { loadConfig } from "../config/load";
import type { SpanicalUserConfig } from "../config/schema";
import { extractAll } from "../extract";
import {
    ensureWindowEndSnapshot,
    resolveWindowStart,
} from "../pipeline/prepare";
import { renderContributorsReport } from "../render";
import { aggregateComplexityAttribution } from "./complexity";
import { aggregateHotspots } from "./hotspots";
import { aggregatePerDev } from "./per-dev";
import type { DevComplexityRollup, DevPeriodRollup } from "./types";

type Author = { name: string; email: string };
type Handle = ReturnType<typeof openCache>;
type SnapshotSeed = { path: string; code: number; complexity: number };

const NOW = new Date("2026-07-19T12:00:00Z");
const PUBLIC_IMPORT = `${import.meta.dir}/../public`;
const REPO_NAME = "app";
const LANGUAGE = "TypeScript";

const DEV_ONE = "dev-one@example.com";
const DEV_TWO = "dev-two@example.com";

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
    const dir = mkdtempSync(join(tmpdir(), "spanical-complexity-repo-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "ci"]);
    git(dir, ["config", "user.email", "ci@example.com"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    return dir;
}

function headSha(dir: string): string {
    const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir });
    if (result.exitCode !== 0) {
        throw new Error(`git rev-parse failed: ${result.stderr.toString()}`);
    }
    return result.stdout.toString().trim();
}

function author(email: string): Author {
    return { name: email.split("@")[0] ?? email, email };
}

function lines(count: number): string {
    return `${Array.from({ length: count }, (_, index) => `l${index + 1}`).join("\n")}\n`;
}

function commit(
    dir: string,
    committer: Author,
    files: Record<string, string>,
    message: string,
    isoDate: string
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
            `--author=${committer.name} <${committer.email}>`,
        ],
        { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate }
    );
}

function writeConfig(config: SpanicalUserConfig): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-complexity-cfg-"));
    const source = `import { defineConfig } from "${PUBLIC_IMPORT}";\nexport default defineConfig(${JSON.stringify(config, null, 4)});\n`;
    writeFileSync(join(dir, "spanical.config.ts"), source);
    return dir;
}

function fixtureConfig(repo: string): SpanicalUserConfig {
    return {
        repos: [{ name: REPO_NAME, path: repo }],
        authors: {
            "dev-one": { emails: [DEV_ONE] },
            "dev-two": { emails: [DEV_TWO] },
        },
    };
}

function seedSnapshot(
    db: CacheDatabase,
    sha: string,
    month: string,
    files: SnapshotSeed[],
    isBoundary: boolean
): void {
    db.insert(sccSnapshots)
        .values(
            files.map((file) => ({
                repo: REPO_NAME,
                month,
                path: file.path,
                language: LANGUAGE,
                code: file.code,
                complexity: file.complexity,
                sha,
                isBoundary,
            }))
        )
        .run();
}

function seedBoundary(
    db: CacheDatabase,
    sha: string,
    month: string,
    files: SnapshotSeed[]
): void {
    seedSnapshot(db, sha, month, files, true);
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

function findDev(
    rows: DevComplexityRollup[],
    name: string
): DevComplexityRollup {
    const row = rows.find((candidate) => candidate.author === name);
    if (row === undefined) {
        throw new Error(`No complexity row for ${name}`);
    }
    return row;
}

type Fixture = { repo: string; juneBoundarySha: string; tipSha: string };

function buildFixtureRepo(): Fixture {
    const repo = initRepo();
    commit(
        repo,
        author(DEV_ONE),
        {
            "src/feature.ts": lines(30),
            "src/side.ts": lines(20),
            "src/orphan.ts": lines(5),
        },
        "feat: dev-one seeds files",
        "2026-06-10T10:00:00Z"
    );
    commit(
        repo,
        author(DEV_TWO),
        { "src/feature.ts": lines(40) },
        "feat: dev-two extends feature",
        "2026-06-20T10:00:00Z"
    );
    const juneBoundarySha = headSha(repo);
    commit(
        repo,
        author(DEV_ONE),
        { "src/feature.ts": lines(10) },
        "refactor: dev-one shrinks feature",
        "2026-07-05T10:00:00Z"
    );
    return { repo, juneBoundarySha, tipSha: headSha(repo) };
}

async function aggregate(
    configDir: string,
    handle: Handle,
    baselineShas: Map<string, string>,
    since: string
): Promise<{
    devs: DevComplexityRollup[];
    unattributed: number;
    contributors: DevPeriodRollup[];
    hotspotPaths: string[];
}> {
    const run = await resolveRunConfig({
        flags: { since },
        cwd: configDir,
        now: NOW,
    });
    const config = await loadConfig({ cwd: configDir });
    const windowEndShas = await ensureWindowEndSnapshot(handle.db, run);
    const start = resolveWindowStart(handle.db, run);
    if (start === null) {
        throw new Error("Expected a resolvable window start");
    }
    const contributors = aggregatePerDev(handle.db, {
        periods: [{ label: run.window.label, start, end: run.window.end }],
        timezone: run.tz,
    });
    const repos = run.repos.map((repo) => repo.name);
    const hotspots = aggregateHotspots(handle.db, {
        window: run.window,
        repos,
        minFileLines: config.hotspot.minFileLines,
        busFactorThreshold: config.hotspot.busFactorThreshold,
        windowEndShas,
    });
    const attribution = aggregateComplexityAttribution(handle.db, {
        window: run.window,
        windowStart: start,
        repos,
        timezone: run.tz,
        minFileLines: config.hotspot.minFileLines,
        busFactorThreshold: config.hotspot.busFactorThreshold,
        windowEndShas,
        baselineShas,
        perDev: contributors,
    });
    return {
        devs: attribution.devs,
        unattributed: attribution.unattributed,
        contributors,
        hotspotPaths: hotspots.map((hotspot) => hotspot.path),
    };
}

test("attributes monthly complexity deltas to devs by churn share", async () => {
    const { repo, juneBoundarySha, tipSha } = buildFixtureRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const handle = openCache({ cwd: configDir });
        try {
            const baselineSha = "baseline-sha";
            seedSnapshot(
                handle.db,
                baselineSha,
                "2026-05",
                [
                    { path: "src/feature.ts", code: 100, complexity: 10 },
                    { path: "src/orphan.ts", code: 40, complexity: 5 },
                ],
                false
            );
            seedBoundary(handle.db, juneBoundarySha, "2026-06", [
                { path: "src/feature.ts", code: 100, complexity: 50 },
                { path: "src/orphan.ts", code: 40, complexity: 5 },
            ]);
            seedBoundary(handle.db, tipSha, "2026-07", [
                { path: "src/feature.ts", code: 100, complexity: 20 },
                { path: "src/orphan.ts", code: 40, complexity: 15 },
            ]);

            const result = await aggregate(
                configDir,
                handle,
                new Map([[REPO_NAME, baselineSha]]),
                "2026-06-01"
            );

            expect(result.hotspotPaths).toEqual(["src/feature.ts"]);

            const devOnePerDev = result.contributors.find(
                (row) => row.author === "dev-one"
            );
            expect(devOnePerDev?.added).toBe(55);
            expect(devOnePerDev?.throughput).toBe(85);

            const devOne = findDev(result.devs, "dev-one");
            const devTwo = findDev(result.devs, "dev-two");

            expect(devTwo.complexityAdded).toBe(10);
            expect(devTwo.complexityRemoved).toBe(0);
            expect(devTwo.complexityNet).toBe(10);
            expect(devTwo.complexityPerAddedLine).toBe(1);
            expect(devTwo.hotspotContribution).toBe(1);

            expect(devOne.complexityAdded).toBe(30);
            expect(devOne.complexityRemoved).toBe(30);
            expect(devOne.complexityNet).toBe(0);
            expect(devOne.complexityPerAddedLine).toBeCloseTo(30 / 55, 10);
            expect(devOne.hotspotContribution).toBeCloseTo(60 / 85, 10);
            expect(devOne.hotspotContribution ?? 0).toBeGreaterThan(0);
            expect(devOne.hotspotContribution ?? 1).toBeLessThan(1);

            expect(result.unattributed).toBe(10);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});

function buildMidMonthFixture(): { repo: string; boundarySha: string } {
    const repo = initRepo();
    commit(
        repo,
        author(DEV_ONE),
        { "src/feature.ts": lines(20) },
        "feat: dev-one seeds feature pre-window",
        "2026-06-10T10:00:00Z"
    );
    commit(
        repo,
        author(DEV_ONE),
        { "src/feature.ts": lines(50) },
        "feat: dev-one grows feature in-window",
        "2026-06-20T10:00:00Z"
    );
    return { repo, boundarySha: headSha(repo) };
}

test("complexityPerAddedLine divides by month-aligned added lines for a mid-month start", async () => {
    const { repo, boundarySha } = buildMidMonthFixture();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const handle = openCache({ cwd: configDir });
        try {
            seedBoundary(handle.db, boundarySha, "2026-06", [
                { path: "src/feature.ts", code: 50, complexity: 60 },
            ]);

            const result = await aggregate(
                configDir,
                handle,
                new Map(),
                "2026-06-15"
            );

            const devOnePerDev = result.contributors.find(
                (row) => row.author === "dev-one"
            );
            expect(devOnePerDev?.added).toBe(30);

            const devOne = findDev(result.devs, "dev-one");
            expect(devOne.complexityAdded).toBe(60);
            expect(devOne.complexityPerAddedLine).toBeCloseTo(60 / 50, 10);
            expect(devOne.complexityPerAddedLine).not.toBeCloseTo(60 / 30, 10);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});

const SAMPLE_CONTRIBUTORS: DevPeriodRollup[] = [
    {
        period: "2026-06",
        authorId: 1,
        author: "dev-one",
        commits: 3,
        added: 55,
        deleted: 30,
        net: 25,
        throughput: 85,
        filesTouched: 3,
        avgCommitSize: 28.33,
        activeDays: 2,
    },
];

const SAMPLE_COMPLEXITY: DevComplexityRollup[] = [
    {
        author: "dev-one",
        authorId: 1,
        complexityAdded: 30,
        complexityRemoved: 30,
        complexityNet: 0,
        complexityPerAddedLine: 30 / 55,
        hotspotContribution: 60 / 85,
    },
];

test("renderContributorsReport json carries both arrays and the unattributed total", () => {
    const json = renderContributorsReport("json", {
        contributors: SAMPLE_CONTRIBUTORS,
        complexity: SAMPLE_COMPLEXITY,
        unattributedComplexity: 10,
    });
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Expected a json object");
    }
    if (
        !("contributors" in parsed) ||
        !("complexity" in parsed) ||
        !("unattributedComplexity" in parsed)
    ) {
        throw new Error("Expected contributors, complexity, unattributed keys");
    }
    const { contributors, complexity, unattributedComplexity } = parsed;
    if (!Array.isArray(contributors) || !Array.isArray(complexity)) {
        throw new Error("Expected contributors and complexity arrays");
    }
    expect(contributors).toHaveLength(1);
    expect(complexity).toHaveLength(1);
    expect(unattributedComplexity).toBe(10);

    const firstComplexity: unknown = complexity[0];
    if (
        typeof firstComplexity !== "object" ||
        firstComplexity === null ||
        !("complexityRemoved" in firstComplexity)
    ) {
        throw new Error("Expected a complexity row");
    }
    expect(firstComplexity.complexityRemoved).toBe(30);
});

test("renderContributorsReport carries the caveat and notes non-zero unattributed complexity", () => {
    for (const format of ["table", "md"] as const) {
        const withUnattributed = renderContributorsReport(format, {
            contributors: SAMPLE_CONTRIBUTORS,
            complexity: SAMPLE_COMPLEXITY,
            unattributedComplexity: 10,
        });
        expect(withUnattributed).toContain("Complexity removed");
        expect(withUnattributed).toContain("approximate");
        expect(withUnattributed).toContain("could not be attributed");

        const withoutUnattributed = renderContributorsReport(format, {
            contributors: SAMPLE_CONTRIBUTORS,
            complexity: SAMPLE_COMPLEXITY,
            unattributedComplexity: 0,
        });
        expect(withoutUnattributed).not.toContain("could not be attributed");
    }
});
