import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { TypeOf } from "@drizzle-team/brocli";
import { openCache, type CacheDatabase } from "../cache/open";
import { extractions, sccSnapshots } from "../cache/schema";
import type { globalFlags } from "../cli/global-flags";
import { resolveRunConfig } from "../cli/resolve-run";
import { loadConfig } from "../config/load";
import type { SpanicalUserConfig } from "../config/schema";
import { extractAll } from "../extract";
import { ensureOwnership, ensureWindowEndSnapshot } from "../pipeline/prepare";
import { aggregateHotspots } from "./hotspots";
import { aggregateOwnership } from "./ownership";
import type { HotspotRow } from "./types";

type RunFlags = Partial<TypeOf<typeof globalFlags>>;

const NOW = new Date("2026-07-19T12:00:00Z");
const PUBLIC_IMPORT = `${import.meta.dir}/../public`;
const REPO_NAME = "app";
const SNAPSHOT_MONTH = "2026-07";
const LANGUAGE = "TypeScript";
const BUS_FACTOR_THRESHOLD = 0.8;

const DEV_ONE = "dev-one@example.com";
const DEV_TWO = "dev-two@example.com";

type Author = { name: string; email: string };
type Handle = ReturnType<typeof openCache>;
type SnapshotSeed = { path: string; code: number; complexity: number };

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
    const dir = mkdtempSync(join(tmpdir(), "spanical-hotspots-repo-"));
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
    const dir = mkdtempSync(join(tmpdir(), "spanical-hotspots-cfg-"));
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

function readTipSha(db: CacheDatabase): string {
    const row = db
        .select({ tipSha: extractions.tipSha })
        .from(extractions)
        .where(eq(extractions.repo, REPO_NAME))
        .get();
    if (row === undefined) {
        throw new Error("No extraction tip sha for the fixture repo");
    }
    return row.tipSha;
}

function seedSnapshots(
    db: CacheDatabase,
    sha: string,
    files: SnapshotSeed[],
    month: string
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
                isBoundary: false,
            }))
        )
        .run();
}

async function runEnsureOwnership(
    configDir: string,
    handle: Handle
): Promise<void> {
    const run = await resolveRunConfig({ flags: {}, cwd: configDir, now: NOW });
    const config = await loadConfig({ cwd: configDir });
    await ensureOwnership(handle.db, run, config);
}

async function aggregate(
    configDir: string,
    handle: Handle,
    flags: RunFlags = { since: "2026-06-01" }
): Promise<HotspotRow[]> {
    const run = await resolveRunConfig({ flags, cwd: configDir, now: NOW });
    const config = await loadConfig({ cwd: configDir });
    const windowEndShas = await ensureWindowEndSnapshot(handle.db, run);
    return aggregateHotspots(handle.db, {
        window: run.window,
        repos: run.repos.map((repo) => repo.name),
        minFileLines: config.hotspot.minFileLines,
        busFactorThreshold: config.hotspot.busFactorThreshold,
        windowEndShas,
    });
}

function findRow(rows: HotspotRow[], path: string): HotspotRow {
    const row = rows.find((candidate) => candidate.path === path);
    if (row === undefined) {
        throw new Error(`No hotspot row for ${path}`);
    }
    return row;
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

function buildFixtureRepo(): string {
    const repo = initRepo();
    commit(
        repo,
        author(DEV_ONE),
        {
            "src/hot.ts": "h1\nh2\nh3\n",
            "src/busy.ts": "b1\n",
            "src/complex.ts": "x1\n",
            "src/baseline.ts": "z1\n",
            "src/tiny.ts": "t1\n",
            "src/ghost.ts": "g1\n",
        },
        "feat: seed files",
        "2026-06-10T10:00:00Z"
    );
    commit(
        repo,
        author(DEV_ONE),
        {
            "src/hot.ts": "h1\nh2\nh3\nh4\n",
            "src/busy.ts": "b1\nb2\n",
            "src/complex.ts": "x1\nx2\n",
            "src/tiny.ts": "t1\nt2\n",
            "src/ghost.ts": "g1\ng2\n",
        },
        "feat: extend a subset",
        "2026-06-20T10:00:00Z"
    );
    commit(
        repo,
        author(DEV_TWO),
        {
            "src/hot.ts": "h1\nh2\nh3\nh4\nh5\n",
            "src/busy.ts": "b1\nb2\nb3\n",
        },
        "feat: dev-two touches hot and busy",
        "2026-07-05T10:00:00Z"
    );
    return repo;
}

const FIXTURE_SNAPSHOTS: SnapshotSeed[] = [
    { path: "src/hot.ts", code: 100, complexity: 10 },
    { path: "src/busy.ts", code: 100, complexity: 2 },
    { path: "src/complex.ts", code: 100, complexity: 10 },
    { path: "src/baseline.ts", code: 100, complexity: 1 },
    { path: "src/tiny.ts", code: 10, complexity: 10 },
];

test("ranks files by change-frequency x complexity with min-max scored hotspots", async () => {
    const repo = buildFixtureRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const handle = openCache({ cwd: configDir });
        try {
            seedSnapshots(
                handle.db,
                readTipSha(handle.db),
                FIXTURE_SNAPSHOTS,
                SNAPSHOT_MONTH
            );
            await runEnsureOwnership(configDir, handle);

            const rows = await aggregate(configDir, handle);

            expect(rows.map((row) => row.path)).toEqual([
                "src/hot.ts",
                "src/complex.ts",
                "src/busy.ts",
                "src/baseline.ts",
            ]);

            for (const row of rows) {
                expect(row.score).toBeGreaterThanOrEqual(0);
                expect(row.score).toBeLessThanOrEqual(1);
            }

            const hot = findRow(rows, "src/hot.ts");
            expect(hot.changeFrequency).toBe(3);
            expect(hot.complexity).toBe(10);
            expect(hot.freqNorm).toBe(1);
            expect(hot.cxNorm).toBe(1);
            expect(hot.score).toBe(1);

            const complex = findRow(rows, "src/complex.ts");
            expect(complex.changeFrequency).toBe(2);
            expect(complex.score).toBeCloseTo(0.5, 10);

            const busy = findRow(rows, "src/busy.ts");
            expect(busy.changeFrequency).toBe(3);
            expect(busy.score).toBeCloseTo(1 / 9, 10);

            const baseline = findRow(rows, "src/baseline.ts");
            expect(baseline.score).toBe(0);

            expect(
                rows.find((row) => row.path === "src/tiny.ts")
            ).toBeUndefined();
            expect(
                rows.find((row) => row.path === "src/ghost.ts")
            ).toBeUndefined();

            const ownership = aggregateOwnership(handle.db, {
                repos: [REPO_NAME],
                busFactorThreshold: BUS_FACTOR_THRESHOLD,
            });
            const hotOwnership = ownership.files.find(
                (file) => file.path === "src/hot.ts"
            );
            expect(hotOwnership?.ownerCount).toBe(2);
            expect(hot.ownerCount).toBe(2);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});

test("selects a single complexity row per file when the tip advances within a month", async () => {
    const repo = initRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        commit(
            repo,
            author(DEV_ONE),
            { "src/big.ts": "a\nb\nc\n" },
            "feat: dev-one seeds big",
            "2026-06-10T10:00:00Z"
        );
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const tip1 = headSha(repo);

        commit(
            repo,
            author(DEV_TWO),
            { "src/big.ts": "a\nb\nc\nd\ne\n" },
            "feat: dev-two extends big",
            "2026-06-15T10:00:00Z"
        );
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const tip2 = headSha(repo);
        expect(tip2).not.toBe(tip1);

        const handle = openCache({ cwd: configDir });
        try {
            const big: SnapshotSeed[] = [
                { path: "src/big.ts", code: 100, complexity: 10 },
            ];
            seedSnapshots(handle.db, tip1, big, "2026-06");
            seedSnapshots(handle.db, tip2, big, "2026-06");

            await runEnsureOwnership(configDir, handle);

            const rows = await aggregate(configDir, handle);
            const bigRows = rows.filter((row) => row.path === "src/big.ts");
            expect(bigRows).toHaveLength(1);
            expect(findRow(rows, "src/big.ts").changeFrequency).toBe(2);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});

test("reads complexity deterministically from the window-end snapshot when a past month holds multiple SHAs", async () => {
    const repo = initRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        commit(
            repo,
            author(DEV_ONE),
            { "src/big.ts": "a\nb\nc\n" },
            "feat: dev-one seeds big",
            "2026-06-10T10:00:00Z"
        );
        const staleSha = headSha(repo);
        commit(
            repo,
            author(DEV_ONE),
            { "src/big.ts": "a\nb\nc\nd\n" },
            "feat: dev-one extends big at the window end",
            "2026-06-20T10:00:00Z"
        );
        const windowEndSha = headSha(repo);
        commit(
            repo,
            author(DEV_TWO),
            { "src/big.ts": "a\nb\nc\nd\ne\n" },
            "feat: dev-two advances the tip into a later month",
            "2026-07-05T10:00:00Z"
        );
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const tip = headSha(repo);
        expect(new Set([staleSha, windowEndSha, tip]).size).toBe(3);

        const handle = openCache({ cwd: configDir });
        try {
            const windowEndComplexity = 3;
            const staleComplexity = 99;
            seedSnapshots(
                handle.db,
                windowEndSha,
                [
                    {
                        path: "src/big.ts",
                        code: 100,
                        complexity: windowEndComplexity,
                    },
                ],
                "2026-06"
            );
            seedSnapshots(
                handle.db,
                staleSha,
                [
                    {
                        path: "src/big.ts",
                        code: 100,
                        complexity: staleComplexity,
                    },
                ],
                "2026-06"
            );

            const first = await aggregate(configDir, handle, {
                until: "2026-06-25",
            });
            const second = await aggregate(configDir, handle, {
                until: "2026-06-25",
            });
            expect(first).toEqual(second);

            const big = findRow(first, "src/big.ts");
            expect(big.complexity).toBe(windowEndComplexity);
            expect(big.changeFrequency).toBe(2);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});
