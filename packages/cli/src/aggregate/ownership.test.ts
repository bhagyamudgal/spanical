import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { openCache, type CacheDatabase } from "../cache/open";
import { extractions, fileOwnership, sccSnapshots } from "../cache/schema";
import { resolveRunConfig } from "../cli/resolve-run";
import { loadConfig } from "../config/load";
import type { SpanicalUserConfig } from "../config/schema";
import { extractAll } from "../extract";
import { ensureOwnership } from "../pipeline/prepare";
import { aggregateOwnership } from "./ownership";
import type { OwnershipRow } from "./types";

const NOW = new Date("2026-07-19T12:00:00Z");
const PUBLIC_IMPORT = `${import.meta.dir}/../public`;
const REPO_NAME = "app";
const SNAPSHOT_MONTH = "2026-06";
const LANGUAGE = "TypeScript";
const BUS_FACTOR_THRESHOLD = 0.8;

const DEV_ONE = "dev-one@example.com";
const DEV_TWO = "dev-two@example.com";
const DEV_THREE = "dev-three@example.com";

type Author = { name: string; email: string };
type Handle = ReturnType<typeof openCache>;

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
    const dir = mkdtempSync(join(tmpdir(), "spanical-ownership-repo-"));
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

function commit(
    dir: string,
    committer: Author,
    files: Record<string, string>,
    message: string,
    isoDate?: string
): void {
    for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
    }
    git(dir, ["add", "-A"]);
    const env =
        isoDate === undefined
            ? undefined
            : { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate };
    git(
        dir,
        [
            "commit",
            "-q",
            "-m",
            message,
            `--author=${committer.name} <${committer.email}>`,
        ],
        env
    );
}

function writeConfig(config: SpanicalUserConfig): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-ownership-cfg-"));
    const source = `import { defineConfig } from "${PUBLIC_IMPORT}";\nexport default defineConfig(${JSON.stringify(config, null, 4)});\n`;
    writeFileSync(join(dir, "spanical.config.ts"), source);
    return dir;
}

function author(email: string): Author {
    return { name: email.split("@")[0] ?? email, email };
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

function seedSnapshots(db: CacheDatabase, sha: string): void {
    const files: { path: string; code: number }[] = [
        { path: "src/menu/solo.ts", code: 120 },
        { path: "src/shared/three.ts", code: 90 },
        { path: "src/legacy/old.ts", code: 80 },
        { path: "src/mixed/major.ts", code: 100 },
        { path: "src/tiny.ts", code: 10 },
    ];
    db.insert(sccSnapshots)
        .values(
            files.map((file) => ({
                repo: REPO_NAME,
                month: SNAPSHOT_MONTH,
                path: file.path,
                language: LANGUAGE,
                code: file.code,
                complexity: 1,
                sha,
            }))
        )
        .run();
}

function buildFixtureRepo(): string {
    const repo = initRepo();
    commit(
        repo,
        author(DEV_ONE),
        {
            "src/menu/solo.ts": "1\n2\n3\n4\n5\n",
            "src/shared/three.ts": "a\n",
            "src/mixed/major.ts": "x\ny\nz\n",
            "src/tiny.ts": "t1\nt2\n",
        },
        "feat: dev-one seeds files"
    );
    commit(
        repo,
        author(DEV_TWO),
        {
            "src/shared/three.ts": "a\nb\n",
            "src/mixed/major.ts": "x\ny\nz\nw\nv\n",
        },
        "feat: dev-two extends shared and major"
    );
    commit(
        repo,
        author(DEV_THREE),
        { "src/shared/three.ts": "a\nb\nc\n" },
        "feat: dev-three extends shared"
    );
    commit(
        repo,
        author(DEV_TWO),
        { "src/legacy/old.ts": "l1\nl2\nl3\nl4\n" },
        "chore: legacy file untouched since",
        "2020-01-01T00:00:00Z"
    );
    return repo;
}

function fixtureConfig(repo: string): SpanicalUserConfig {
    return {
        repos: [{ name: REPO_NAME, path: repo }],
        authors: {
            "dev-one": { emails: [DEV_ONE] },
            "dev-two": { emails: [DEV_TWO] },
            "dev-three": { emails: [DEV_THREE] },
        },
    };
}

async function runEnsureOwnership(
    configDir: string,
    handle: Handle
): Promise<void> {
    const run = await resolveRunConfig({ flags: {}, cwd: configDir, now: NOW });
    const config = await loadConfig({ cwd: configDir });
    await ensureOwnership(handle.db, run, config);
}

function findFile(rows: OwnershipRow[], path: string): OwnershipRow {
    const row = rows.find((candidate) => candidate.path === path);
    if (row === undefined) {
        throw new Error(`No ownership row for ${path}`);
    }
    return row;
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("classifies sole, primary, and shared ownership and maps bus-factor by directory", async () => {
    const repo = buildFixtureRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const handle = openCache({ cwd: configDir });
        try {
            seedSnapshots(handle.db, readTipSha(handle.db));
            await runEnsureOwnership(configDir, handle);

            const { files, busFactor } = aggregateOwnership(handle.db, {
                repos: [REPO_NAME],
                busFactorThreshold: BUS_FACTOR_THRESHOLD,
            });

            expect(files.map((file) => file.path).sort()).toEqual([
                "src/legacy/old.ts",
                "src/menu/solo.ts",
                "src/mixed/major.ts",
                "src/shared/three.ts",
            ]);

            const solo = findFile(files, "src/menu/solo.ts");
            expect(solo.totalLines).toBe(5);
            expect(solo.ownerCount).toBe(1);
            expect(solo.primaryOwner).toBe("dev-one");
            expect(solo.primaryShare).toBe(1);
            expect(solo.isSoleOwned).toBe(true);
            expect(solo.soleOwner).toBe("dev-one");

            const shared = findFile(files, "src/shared/three.ts");
            expect(shared.totalLines).toBe(3);
            expect(shared.ownerCount).toBe(3);
            expect(shared.primaryOwner).toBeNull();
            expect(shared.isSoleOwned).toBe(false);
            expect(
                shared.shares.every((share) => share.survivingLines === 1)
            ).toBe(true);

            const major = findFile(files, "src/mixed/major.ts");
            expect(major.totalLines).toBe(5);
            expect(major.ownerCount).toBe(2);
            expect(major.primaryOwner).toBe("dev-one");
            expect(major.primaryShare).toBeCloseTo(0.6, 10);
            expect(major.isSoleOwned).toBe(false);
            expect(major.soleOwner).toBeNull();

            const legacy = findFile(files, "src/legacy/old.ts");
            expect(legacy.totalLines).toBe(4);
            expect(legacy.isSoleOwned).toBe(true);
            expect(legacy.soleOwner).toBe("dev-two");

            expect(busFactor).toEqual([
                {
                    repo: REPO_NAME,
                    dir: "src/legacy",
                    soleOwnedCount: 1,
                    owners: ["dev-two"],
                },
                {
                    repo: REPO_NAME,
                    dir: "src/menu",
                    soleOwnedCount: 1,
                    owners: ["dev-one"],
                },
            ]);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});

test("reuses cached ownership on a second run with an unchanged tip", async () => {
    const repo = buildFixtureRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const handle = openCache({ cwd: configDir });
        try {
            seedSnapshots(handle.db, readTipSha(handle.db));
            await runEnsureOwnership(configDir, handle);

            const sentinel = 777;
            handle.db
                .update(fileOwnership)
                .set({ survivingLines: sentinel })
                .where(
                    and(
                        eq(fileOwnership.repo, REPO_NAME),
                        eq(fileOwnership.path, "src/menu/solo.ts")
                    )
                )
                .run();

            await runEnsureOwnership(configDir, handle);

            const solo = handle.db
                .select({ survivingLines: fileOwnership.survivingLines })
                .from(fileOwnership)
                .where(
                    and(
                        eq(fileOwnership.repo, REPO_NAME),
                        eq(fileOwnership.path, "src/menu/solo.ts")
                    )
                )
                .get();
            expect(solo?.survivingLines).toBe(sentinel);
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});

test("does not crash when a calendar month holds multiple snapshot SHAs after the tip advances", async () => {
    const repo = initRepo();
    const configDir = writeConfig(fixtureConfig(repo));
    try {
        commit(
            repo,
            author(DEV_ONE),
            { "src/app/big.ts": "a\nb\nc\n" },
            "feat: dev-one seeds big"
        );
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const tip1 = headSha(repo);

        commit(
            repo,
            author(DEV_TWO),
            { "src/app/big.ts": "a\nb\nc\nd\ne\n" },
            "feat: dev-two extends big"
        );
        await extractAll({ cwd: configDir, noCache: true, now: NOW });
        const tip2 = headSha(repo);
        expect(tip2).not.toBe(tip1);

        const handle = openCache({ cwd: configDir });
        try {
            for (const sha of [tip1, tip2]) {
                handle.db
                    .insert(sccSnapshots)
                    .values({
                        repo: REPO_NAME,
                        month: SNAPSHOT_MONTH,
                        path: "src/app/big.ts",
                        language: LANGUAGE,
                        code: 120,
                        complexity: 1,
                        sha,
                    })
                    .run();
            }

            await runEnsureOwnership(configDir, handle);

            const { files } = aggregateOwnership(handle.db, {
                repos: [REPO_NAME],
                busFactorThreshold: BUS_FACTOR_THRESHOLD,
            });
            const big = findFile(files, "src/app/big.ts");
            expect(big.totalLines).toBe(5);
            expect(big.ownerCount).toBe(2);
            expect(big.primaryOwner).toBe("dev-one");
        } finally {
            handle.sqlite.close();
        }
    } finally {
        cleanup([repo, configDir]);
    }
});
