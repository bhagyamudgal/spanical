import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { and, count, eq, gte, inArray, min } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import {
    commits,
    extractions,
    fileOwnership,
    sccSnapshots,
} from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import type { SpanicalConfig } from "../config/schema";
import { extractAll } from "../extract";
import { seedAndResolveAuthors, type AuthorResolver } from "../extract/authors";
import { blameFile } from "../extract/blame";
import { resolveDefaultBranch, runGit } from "../extract/git";
import {
    resolveSccBinary,
    snapshotRepo,
    snapshotSha,
    type SnapshotBoundary,
} from "../scc";
import { generatePeriods } from "../window";

const OWNERSHIP_INSERT_BATCH_SIZE = 1000;
const SNAPSHOT_MONTH_FORMAT = "yyyy-MM";

type OwnershipInsertRow = typeof fileOwnership.$inferInsert;
type RepoRef = { name: string; path: string; branch?: string };

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

function tipSnapshotFiles(
    db: CacheDatabase,
    repoName: string,
    tipSha: string,
    minFileLines: number
): string[] {
    return db
        .select({ path: sccSnapshots.path })
        .from(sccSnapshots)
        .where(
            and(
                eq(sccSnapshots.repo, repoName),
                eq(sccSnapshots.sha, tipSha),
                gte(sccSnapshots.code, minFileLines)
            )
        )
        .all()
        .map((row) => row.path);
}

async function commitMonth(
    repoPath: string,
    sha: string,
    timezone: string
): Promise<string> {
    const iso = (
        await runGit(["show", "-s", "--format=%cI", sha], repoPath)
    ).trim();
    return format(
        new TZDate(new Date(iso).getTime(), timezone),
        SNAPSHOT_MONTH_FORMAT
    );
}

async function ensureSnapshotAt(
    db: CacheDatabase,
    repo: RepoRef,
    sha: string,
    timezone: string
): Promise<void> {
    const existing = db
        .select({ sha: sccSnapshots.sha })
        .from(sccSnapshots)
        .where(and(eq(sccSnapshots.repo, repo.name), eq(sccSnapshots.sha, sha)))
        .get();
    if (existing) {
        return;
    }
    const sccBinary = await resolveSccBinary();
    const month = await commitMonth(repo.path, sha, timezone);
    await snapshotSha(db, repo, month, sha, sccBinary);
}

async function resolveCommitBefore(
    repoPath: string,
    branch: string,
    end: Date
): Promise<string | null> {
    const sha = (
        await runGit(
            ["rev-list", "-1", `--before=${end.toISOString()}`, branch],
            repoPath
        )
    ).trim();
    return sha.length === 0 ? null : sha;
}

export async function ensureWindowEndSnapshot(
    db: CacheDatabase,
    run: ResolvedRun
): Promise<Map<string, string>> {
    const shaByRepo = new Map<string, string>();
    for (const repo of run.repos) {
        const branch = await resolveDefaultBranch(repo.path, repo.branch);
        const windowEndSha = await resolveCommitBefore(
            repo.path,
            branch,
            run.window.end
        );
        if (windowEndSha === null) {
            continue;
        }
        await ensureSnapshotAt(db, repo, windowEndSha, run.tz);
        shaByRepo.set(repo.name, windowEndSha);
    }
    return shaByRepo;
}

export async function ensureBaselineSnapshots(
    db: CacheDatabase,
    run: ResolvedRun
): Promise<Map<string, string>> {
    const shaByRepo = new Map<string, string>();
    const startDate = resolveWindowStart(db, run);
    if (startDate === null) {
        return shaByRepo;
    }
    const [firstMonth] = generatePeriods(
        startDate,
        run.window.end,
        "month",
        run.tz
    );
    if (firstMonth === undefined) {
        return shaByRepo;
    }
    for (const repo of run.repos) {
        const branch = await resolveDefaultBranch(repo.path, repo.branch);
        const baselineSha = await resolveCommitBefore(
            repo.path,
            branch,
            firstMonth.start
        );
        if (baselineSha === null) {
            continue;
        }
        await ensureSnapshotAt(db, repo, baselineSha, run.tz);
        shaByRepo.set(repo.name, baselineSha);
    }
    return shaByRepo;
}

async function blameRepoOwnership(
    db: CacheDatabase,
    resolver: AuthorResolver,
    repo: RepoRef,
    tipSha: string,
    minFileLines: number
): Promise<void> {
    const paths = tipSnapshotFiles(db, repo.name, tipSha, minFileLines);
    const rows: OwnershipInsertRow[] = [];

    for (const path of paths) {
        const tally = await blameFile(repo.path, tipSha, path);
        if (tally === null) {
            continue;
        }
        const linesByAuthor = new Map<number, number>();
        for (const [email, entry] of tally) {
            const authorId = resolver.resolve(email, entry.name);
            linesByAuthor.set(
                authorId,
                (linesByAuthor.get(authorId) ?? 0) + entry.lines
            );
        }
        for (const [authorId, survivingLines] of linesByAuthor) {
            rows.push({
                repo: repo.name,
                headSha: tipSha,
                path,
                authorId,
                survivingLines,
            });
        }
    }

    if (rows.length === 0) {
        if (paths.length > 0) {
            process.stderr.write(
                `warning: ownership blame produced no surviving lines for ${repo.name} across ${paths.length} candidate file(s); git blame may be failing.\n`
            );
        }
        return;
    }
    db.transaction((tx) => {
        for (
            let start = 0;
            start < rows.length;
            start += OWNERSHIP_INSERT_BATCH_SIZE
        ) {
            tx.insert(fileOwnership)
                .values(rows.slice(start, start + OWNERSHIP_INSERT_BATCH_SIZE))
                .run();
        }
    });
}

export async function ensureOwnership(
    db: CacheDatabase,
    run: ResolvedRun,
    config: SpanicalConfig
): Promise<void> {
    const resolver = seedAndResolveAuthors(db, config);
    for (const repo of run.repos) {
        const extraction = db
            .select({ tipSha: extractions.tipSha })
            .from(extractions)
            .where(eq(extractions.repo, repo.name))
            .get();
        if (!extraction) {
            continue;
        }
        const tipSha = extraction.tipSha;
        const cached = db
            .select({ value: count() })
            .from(fileOwnership)
            .where(
                and(
                    eq(fileOwnership.repo, repo.name),
                    eq(fileOwnership.headSha, tipSha)
                )
            )
            .get();
        if ((cached?.value ?? 0) > 0) {
            continue;
        }
        await ensureSnapshotAt(db, repo, tipSha, run.tz);
        await blameRepoOwnership(
            db,
            resolver,
            repo,
            tipSha,
            config.hotspot.minFileLines
        );
    }
}
