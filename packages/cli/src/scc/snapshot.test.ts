import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { tryCatch } from "@spanical/utils";
import { aggregateSizeTrend } from "../aggregate/size";
import { rebuildSchema, type CacheDatabase } from "../cache/open";
import { cacheSchema, sccSnapshots } from "../cache/schema";
import { SCC_ERROR_CODES, SccError } from "./errors";
import { resolveSccBinary } from "./resolve";
import { snapshotRepo, snapshotSha, type SnapshotBoundary } from "./snapshot";

const SCC_ON_PATH = Bun.which("scc");

const CLASSIFY_TS = `export function classify(value: number): string {
    if (value > 0) {
        return "positive";
    }

    return "other";
}
`;

const CLASSIFY_PATH = "src/classify.ts";
const CLASSIFY_CODE = 6;
const CLASSIFY_COMPLEXITY = 1;

const DEC_BOUNDARY: SnapshotBoundary = {
    month: "2025-12",
    end: new Date("2026-01-01T00:00:00Z"),
};
const JAN_BOUNDARY: SnapshotBoundary = {
    month: "2026-01",
    end: new Date("2026-02-01T00:00:00Z"),
};
const FEB_BOUNDARY: SnapshotBoundary = {
    month: "2026-02",
    end: new Date("2026-03-01T00:00:00Z"),
};

function git(
    cwd: string,
    args: string[],
    env?: Record<string, string>
): string {
    const result = Bun.spawnSync(["git", ...args], {
        cwd,
        env: { ...process.env, ...env },
    });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`
        );
    }
    return result.stdout.toString();
}

function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-scc-repo-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "ci"]);
    git(dir, ["config", "user.email", "ci@example.com"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    return dir;
}

function commitAt(
    dir: string,
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
    git(dir, ["commit", "-q", "-m", message], {
        GIT_AUTHOR_DATE: isoDate,
        GIT_COMMITTER_DATE: isoDate,
    });
}

function headSha(dir: string): string {
    return git(dir, ["rev-parse", "HEAD"]).trim();
}

function buildRepo(): { repo: string; shaA: string; shaB: string } {
    const repo = initRepo();
    commitAt(
        repo,
        "2026-01-15T10:00:00Z",
        { [CLASSIFY_PATH]: CLASSIFY_TS },
        "feat: classify"
    );
    const shaA = headSha(repo);
    commitAt(
        repo,
        "2026-02-15T10:00:00Z",
        { "src/extra.ts": "export const extra = 1;\n" },
        "feat: extra"
    );
    const shaB = headSha(repo);
    return { repo, shaA, shaB };
}

function worktreeCount(repoPath: string): number {
    return git(repoPath, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length;
}

function openTestCache(): { db: CacheDatabase; sqlite: Database } {
    const sqlite = new Database(":memory:");
    rebuildSchema(sqlite);
    return { db: drizzle(sqlite, { schema: cacheSchema }), sqlite };
}

function totalSnapshotRows(db: CacheDatabase): number {
    return db.select({ value: count() }).from(sccSnapshots).get()?.value ?? -1;
}

function boundaryShas(
    db: CacheDatabase,
    repo: string,
    month: string
): string[] {
    const rows = db
        .select({ sha: sccSnapshots.sha })
        .from(sccSnapshots)
        .where(
            and(
                eq(sccSnapshots.repo, repo),
                eq(sccSnapshots.month, month),
                eq(sccSnapshots.isBoundary, true)
            )
        )
        .all();
    return [...new Set(rows.map((row) => row.sha))];
}

function rowsForSha(db: CacheDatabase, sha: string): number {
    return (
        db
            .select({ value: count() })
            .from(sccSnapshots)
            .where(eq(sccSnapshots.sha, sha))
            .get()?.value ?? -1
    );
}

function cleanup(dirs: string[]): void {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
}

test.skipIf(SCC_ON_PATH === null)(
    "records snapshots at two month boundaries for the correct SHAs",
    async () => {
        const sccBinary = await resolveSccBinary();
        const { repo, shaA, shaB } = buildRepo();
        const { db, sqlite } = openTestCache();
        try {
            const result = await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                [JAN_BOUNDARY, FEB_BOUNDARY],
                sccBinary
            );

            expect(result.snapshots).toEqual([
                { month: "2026-01", sha: shaA, status: "inserted" },
                { month: "2026-02", sha: shaB, status: "inserted" },
            ]);

            const janRow = db
                .select()
                .from(sccSnapshots)
                .where(
                    and(
                        eq(sccSnapshots.month, "2026-01"),
                        eq(sccSnapshots.path, CLASSIFY_PATH)
                    )
                )
                .get();
            expect(janRow).toBeDefined();
            expect(janRow?.repo).toBe("web-app");
            expect(janRow?.sha).toBe(shaA);
            expect(janRow?.language).toBe("TypeScript");
            expect(janRow?.code).toBe(CLASSIFY_CODE);
            expect(janRow?.complexity).toBe(CLASSIFY_COMPLEXITY);

            const febRow = db
                .select()
                .from(sccSnapshots)
                .where(
                    and(
                        eq(sccSnapshots.month, "2026-02"),
                        eq(sccSnapshots.path, CLASSIFY_PATH)
                    )
                )
                .get();
            expect(febRow?.sha).toBe(shaB);
            expect(febRow?.language).toBe("TypeScript");
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "is idempotent across a second run over the same boundaries",
    async () => {
        const sccBinary = await resolveSccBinary();
        const { repo } = buildRepo();
        const { db, sqlite } = openTestCache();
        try {
            const boundaries = [JAN_BOUNDARY, FEB_BOUNDARY];
            await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                boundaries,
                sccBinary
            );
            const rowsAfterFirst = totalSnapshotRows(db);
            expect(rowsAfterFirst).toBeGreaterThan(0);

            const second = await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                boundaries,
                sccBinary
            );
            expect(second.snapshots.every((s) => s.status === "skipped")).toBe(
                true
            );
            expect(totalSnapshotRows(db)).toBe(rowsAfterFirst);
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "removes the worktree after a successful run",
    async () => {
        const sccBinary = await resolveSccBinary();
        const { repo } = buildRepo();
        const { db, sqlite } = openTestCache();
        try {
            await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                [FEB_BOUNDARY],
                sccBinary
            );
            expect(worktreeCount(repo)).toBe(1);
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "removes the worktree when scc fails",
    async () => {
        const { repo } = buildRepo();
        const { db, sqlite } = openTestCache();
        try {
            const { error } = await tryCatch(
                snapshotRepo(
                    db,
                    { name: "web-app", path: repo },
                    "main",
                    [FEB_BOUNDARY],
                    "/nonexistent/scc-binary-xyz"
                )
            );
            expect(error).toBeInstanceOf(SccError);
            expect(worktreeCount(repo)).toBe(1);
            expect(totalSnapshotRows(db)).toBe(0);
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "records no-commit for a boundary before the first commit",
    async () => {
        const sccBinary = await resolveSccBinary();
        const { repo } = buildRepo();
        const { db, sqlite } = openTestCache();
        try {
            const result = await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                [DEC_BOUNDARY],
                sccBinary
            );
            expect(result.snapshots).toEqual([
                { month: "2025-12", sha: "", status: "no-commit" },
            ]);
            expect(totalSnapshotRows(db)).toBe(0);
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "throws SHALLOW_HISTORY for a shallow clone",
    async () => {
        const sccBinary = await resolveSccBinary();
        const { repo } = buildRepo();
        const clonesParent = mkdtempSync(join(tmpdir(), "spanical-scc-clone-"));
        const { db, sqlite } = openTestCache();
        try {
            const shallow = join(clonesParent, "shallow");
            git(clonesParent, [
                "clone",
                "--depth=1",
                "-q",
                `file://${repo}`,
                shallow,
            ]);

            const { error } = await tryCatch(
                snapshotRepo(
                    db,
                    { name: "web-app", path: shallow },
                    "main",
                    [FEB_BOUNDARY],
                    sccBinary
                )
            );
            expect(error).toBeInstanceOf(SccError);
            if (error instanceof SccError) {
                expect(error.code).toBe(SCC_ERROR_CODES.SHALLOW_HISTORY);
            }
        } finally {
            sqlite.close();
            cleanup([repo, clonesParent]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "self-heals a month to a single boundary snapshot when the tip advances",
    async () => {
        const sccBinary = await resolveSccBinary();
        const repo = initRepo();
        commitAt(
            repo,
            "2026-02-15T10:00:00Z",
            { [CLASSIFY_PATH]: CLASSIFY_TS },
            "feat: classify"
        );
        const shaA = headSha(repo);
        const { db, sqlite } = openTestCache();
        try {
            await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                [FEB_BOUNDARY],
                sccBinary
            );
            expect(boundaryShas(db, "web-app", "2026-02")).toEqual([shaA]);

            git(repo, ["commit", "-q", "--allow-empty", "-m", "chore: retrigger"], {
                GIT_AUTHOR_DATE: "2026-02-20T10:00:00Z",
                GIT_COMMITTER_DATE: "2026-02-20T10:00:00Z",
            });
            const shaB = headSha(repo);
            expect(shaB).not.toBe(shaA);

            const second = await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                [FEB_BOUNDARY],
                sccBinary
            );
            expect(second.snapshots).toEqual([
                { month: "2026-02", sha: shaB, status: "inserted" },
            ]);

            expect(boundaryShas(db, "web-app", "2026-02")).toEqual([shaB]);
            expect(rowsForSha(db, shaA)).toBe(0);

            const trend = aggregateSizeTrend(db, { repo: "web-app" });
            const february = trend.find((point) => point.month === "2026-02");
            expect(february?.totalCode).toBe(CLASSIFY_CODE);
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);

test.skipIf(SCC_ON_PATH === null)(
    "promotes an existing point-in-time snapshot to the month's boundary on skip",
    async () => {
        const sccBinary = await resolveSccBinary();
        const repo = initRepo();
        commitAt(
            repo,
            "2026-02-15T10:00:00Z",
            { [CLASSIFY_PATH]: CLASSIFY_TS },
            "feat: classify"
        );
        const sha = headSha(repo);
        const { db, sqlite } = openTestCache();
        try {
            await snapshotSha(
                db,
                { name: "web-app", path: repo },
                "2026-02",
                sha,
                sccBinary
            );
            expect(boundaryShas(db, "web-app", "2026-02")).toEqual([]);

            const result = await snapshotRepo(
                db,
                { name: "web-app", path: repo },
                "main",
                [FEB_BOUNDARY],
                sccBinary
            );
            expect(result.snapshots).toEqual([
                { month: "2026-02", sha, status: "skipped" },
            ]);

            expect(boundaryShas(db, "web-app", "2026-02")).toEqual([sha]);

            const trend = aggregateSizeTrend(db, { repo: "web-app" });
            const february = trend.find((point) => point.month === "2026-02");
            expect(february?.totalCode).toBe(CLASSIFY_CODE);
        } finally {
            sqlite.close();
            cleanup([repo]);
        }
    }
);
