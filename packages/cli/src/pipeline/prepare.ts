import { inArray, min } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { commits } from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import { extractAll } from "../extract";
import { resolveDefaultBranch } from "../extract/git";
import { resolveSccBinary, snapshotRepo, type SnapshotBoundary } from "../scc";
import { generatePeriods } from "../window";

export async function ensureExtracted(
    configPath: string | undefined,
    cache: boolean,
    now: Date
): Promise<void> {
    await extractAll({ configPath, noCache: !cache, now });
}

export function earliestCommitInstant(
    db: CacheDatabase,
    repoNames: string[]
): number | null {
    if (repoNames.length === 0) {
        return null;
    }
    const row = db
        .select({ instant: min(commits.authoredAt) })
        .from(commits)
        .where(inArray(commits.repo, repoNames))
        .get();
    return row?.instant ?? null;
}

export function resolveWindowStart(
    db: CacheDatabase,
    run: ResolvedRun
): Date | null {
    if (run.window.start !== null) {
        return run.window.start;
    }
    const earliest = earliestCommitInstant(
        db,
        run.repos.map((repo) => repo.name)
    );
    return earliest === null ? null : new Date(earliest);
}

export async function ensureMonthlySnapshots(
    db: CacheDatabase,
    run: ResolvedRun
): Promise<void> {
    const startDate = resolveWindowStart(db, run);
    if (startDate === null) {
        return;
    }

    const boundaries: SnapshotBoundary[] = generatePeriods(
        startDate,
        run.window.end,
        "month",
        run.tz
    ).map((period) => ({ month: period.label, end: period.end }));

    const scc = await resolveSccBinary();
    for (const repo of run.repos) {
        const branch = await resolveDefaultBranch(repo.path, repo.branch);
        await snapshotRepo(db, repo, branch, boundaries, scc);
    }
}
