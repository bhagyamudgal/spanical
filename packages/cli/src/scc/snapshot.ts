import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { tryCatch } from "@spanical/utils";
import type { CacheDatabase } from "../cache/open";
import { sccSnapshots } from "../cache/schema";
import { runGit } from "../extract/git";
import { SCC_ERROR_CODES, SccError } from "./errors";
import { runScc } from "./run";

const SHALLOW_TRUE = "true";
const SNAPSHOT_INSERT_BATCH_SIZE = 1000;

type SnapshotStatus = "inserted" | "skipped" | "no-commit";

export type SnapshotBoundary = { month: string; end: Date };

export type SnapshotResult = {
    repo: string;
    snapshots: { month: string; sha: string; status: SnapshotStatus }[];
};

type RepoRef = { name: string; path: string; branch?: string };

type SnapshotRow = typeof sccSnapshots.$inferInsert;

export async function snapshotRepo(
    db: CacheDatabase,
    repo: RepoRef,
    branch: string,
    boundaries: SnapshotBoundary[],
    sccBinary: string
): Promise<SnapshotResult> {
    const shallow = (
        await runGit(["rev-parse", "--is-shallow-repository"], repo.path)
    ).trim();
    if (shallow === SHALLOW_TRUE) {
        throw new SccError(
            SCC_ERROR_CODES.SHALLOW_HISTORY,
            `Cannot snapshot a shallow clone in ${repo.path}: git history is truncated. Run "git fetch --unshallow" to restore full history first.`
        );
    }

    const snapshots: SnapshotResult["snapshots"] = [];
    for (const boundary of boundaries) {
        snapshots.push(
            await snapshotBoundary(db, repo, branch, boundary, sccBinary)
        );
    }
    return { repo: repo.name, snapshots };
}

async function snapshotBoundary(
    db: CacheDatabase,
    repo: RepoRef,
    branch: string,
    boundary: SnapshotBoundary,
    sccBinary: string
): Promise<SnapshotResult["snapshots"][number]> {
    const sha = (
        await runGit(
            [
                "rev-list",
                "-1",
                `--before=${boundary.end.toISOString()}`,
                branch,
            ],
            repo.path
        )
    ).trim();
    if (sha.length === 0) {
        return { month: boundary.month, sha: "", status: "no-commit" };
    }

    const existing = db
        .select({ sha: sccSnapshots.sha })
        .from(sccSnapshots)
        .where(and(eq(sccSnapshots.repo, repo.name), eq(sccSnapshots.sha, sha)))
        .get();
    if (existing) {
        return { month: boundary.month, sha, status: "skipped" };
    }

    await snapshotCommit(db, repo, boundary.month, sha, sccBinary);
    return { month: boundary.month, sha, status: "inserted" };
}

async function snapshotCommit(
    db: CacheDatabase,
    repo: RepoRef,
    month: string,
    sha: string,
    sccBinary: string
): Promise<void> {
    const worktreeDir = mkdtempSync(join(tmpdir(), "spanical-scc-worktree-"));
    const added = await tryCatch(
        runGit(["worktree", "add", "--detach", worktreeDir, sha], repo.path)
    );
    if (added.error) {
        rmSync(worktreeDir, { recursive: true, force: true });
        throw new SccError(
            SCC_ERROR_CODES.WORKTREE_FAILED,
            `Failed to create worktree for ${sha} in ${repo.path}: ${added.error.message}`,
            { cause: added.error }
        );
    }

    const scan = await tryCatch(
        scanAndInsert(db, repo.name, month, sha, sccBinary, worktreeDir)
    );
    await cleanupWorktree(repo.path, worktreeDir);
    if (scan.error) {
        throw scan.error;
    }
}

async function scanAndInsert(
    db: CacheDatabase,
    repo: string,
    month: string,
    sha: string,
    sccBinary: string,
    worktreeDir: string
): Promise<void> {
    const entries = await runScc(sccBinary, worktreeDir);
    const rows: SnapshotRow[] = entries.map((entry) => ({
        repo,
        month,
        path: entry.path,
        language: entry.language,
        code: entry.code,
        complexity: entry.complexity,
        sha,
    }));
    if (rows.length === 0) {
        return;
    }
    db.transaction((tx) => {
        for (
            let start = 0;
            start < rows.length;
            start += SNAPSHOT_INSERT_BATCH_SIZE
        ) {
            tx.insert(sccSnapshots)
                .values(rows.slice(start, start + SNAPSHOT_INSERT_BATCH_SIZE))
                .run();
        }
    });
}

async function cleanupWorktree(
    repoPath: string,
    worktreeDir: string
): Promise<void> {
    await tryCatch(
        runGit(["worktree", "remove", "--force", worktreeDir], repoPath)
    );
    rmSync(worktreeDir, { recursive: true, force: true });
}
