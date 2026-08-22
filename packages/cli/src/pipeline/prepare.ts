import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { and, count, eq, gt, gte, inArray, min, or } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import {
    commits,
    extractions,
    fileChanges,
    fileOwnership,
    lineDeaths,
    reworkCaptures,
    sccSnapshots,
} from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import type { SpanicalConfig } from "../config/schema";
import { extractWithConfig } from "../extract";
import { seedAndResolveAuthors, type AuthorResolver } from "../extract/authors";
import { blameFile, type BlameTally } from "../extract/blame";
import { resolveDefaultBranch, runGit } from "../extract/git";
import {
    captureLineDeaths,
    type LineDeathCandidate,
    type LineDeathRecord,
} from "../extract/rework";
import {
    resolveSccBinary,
    snapshotRepo,
    snapshotSha,
    type SnapshotBoundary,
    type SnapshotResult,
} from "../scc";
import { generatePeriods } from "../window";

const INSERT_BATCH_SIZE = 1000;
const CAPTURE_PAGE_SIZE = 500;
const BLAME_CONCURRENCY = 16;
const SNAPSHOT_MONTH_FORMAT = "yyyy-MM";

type OwnershipInsertRow = typeof fileOwnership.$inferInsert;
type LineDeathInsertRow = typeof lineDeaths.$inferInsert;
type RepoRef = { name: string; path: string; branch?: string };

export async function ensureExtracted(
    run: ResolvedRun,
    configPath: string | undefined,
    now: Date
): Promise<void> {
    await extractWithConfig(run.config, {
        configPath,
        noCache: !run.cache,
        now,
    });
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
): Promise<{
    months: string[];
    snapshots: SnapshotResult[];
    windowEndShas: Map<string, string>;
}> {
    const startDate = resolveWindowStart(db, run);
    if (startDate === null || startDate >= run.window.end) {
        return {
            months: [],
            snapshots: [],
            windowEndShas: new Map(),
        };
    }

    const boundaries: SnapshotBoundary[] = generatePeriods(
        startDate,
        run.window.end,
        "month",
        run.tz
    ).map((period) => ({
        month: period.label,
        end:
            period.end.getTime() > run.window.end.getTime()
                ? run.window.end
                : period.end,
    }));

    const scc = await resolveSccBinary();
    const snapshots: SnapshotResult[] = [];
    const windowEndShas = new Map<string, string>();
    for (const repo of run.repos) {
        const branch = await resolveDefaultBranch(repo.path, repo.branch);
        const result = await snapshotRepo(db, repo, branch, boundaries, scc);
        snapshots.push(result);
        const finalSnapshot = result.snapshots.at(-1);
        if (
            finalSnapshot !== undefined &&
            finalSnapshot.status !== "no-commit"
        ) {
            windowEndShas.set(repo.name, finalSnapshot.sha);
        }
    }
    return {
        months: boundaries.map((boundary) => boundary.month),
        snapshots,
        windowEndShas,
    };
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

    const blameResults: { path: string; tally: BlameTally | null }[] = [];
    for (let start = 0; start < paths.length; start += BLAME_CONCURRENCY) {
        const chunk = paths.slice(start, start + BLAME_CONCURRENCY);
        const chunkResults = await Promise.all(
            chunk.map(async (path) => ({
                path,
                tally: await blameFile(repo.path, tipSha, path),
            }))
        );
        blameResults.push(...chunkResults);
    }

    for (const { path, tally } of blameResults) {
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
        for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
            tx.insert(fileOwnership)
                .values(rows.slice(start, start + INSERT_BATCH_SIZE))
                .onConflictDoNothing()
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

// Deletion candidates mirror file_changes scope: excludes and migrations were
// already applied at ingest, so rework never counts lines those filters drop.
// Keyset paging on the (sha, path) primary key keeps memory flat on repos
// whose whole lifetime history has deletions.
function reworkCandidates(
    db: CacheDatabase,
    repoName: string,
    after: LineDeathCandidate | null,
    limit: number
): LineDeathCandidate[] {
    return db
        .select({ sha: fileChanges.sha, path: fileChanges.path })
        .from(fileChanges)
        .where(
            and(
                eq(fileChanges.repo, repoName),
                eq(fileChanges.isBinary, false),
                eq(fileChanges.isMigration, false),
                gt(fileChanges.deleted, 0),
                after === null
                    ? undefined
                    : or(
                          gt(fileChanges.sha, after.sha),
                          and(
                              eq(fileChanges.sha, after.sha),
                              gt(fileChanges.path, after.path)
                          )
                      )
            )
        )
        .orderBy(fileChanges.sha, fileChanges.path)
        .limit(limit)
        .all();
}

export type ReworkCaptureOutcome = {
    // Repos whose capture finished with failed candidates: their reworkLines
    // are undercounts and every rendered surface must say so.
    incompleteRepos: string[];
    unknownEmails: string[];
};

export async function ensureRework(
    db: CacheDatabase,
    run: Pick<ResolvedRun, "repos">,
    config: SpanicalConfig,
    deps: { captureLineDeaths?: typeof captureLineDeaths } = {}
): Promise<ReworkCaptureOutcome> {
    const captureLineDeathsFn = deps.captureLineDeaths ?? captureLineDeaths;
    const resolver = seedAndResolveAuthors(db, config);
    const incompleteRepos: string[] = [];
    for (const repo of run.repos) {
        const extraction = db
            .select({ tipSha: extractions.tipSha })
            .from(extractions)
            .where(eq(extractions.repo, repo.name))
            .get();
        if (!extraction) {
            continue;
        }
        // Only a capture that finished without failed candidates may skip:
        // a partial capture's rows would otherwise freeze its undercount in
        // place until the next re-extraction.
        const marker = db
            .select({ failedCandidates: reworkCaptures.failedCandidates })
            .from(reworkCaptures)
            .where(eq(reworkCaptures.repo, repo.name))
            .get();
        if (marker && marker.failedCandidates === 0) {
            continue;
        }
        let lastKey: LineDeathCandidate | null = null;
        let candidateCount = 0;
        let totalFailed = 0;
        let capturedAny = false;
        for (;;) {
            const candidates = reworkCandidates(
                db,
                repo.name,
                lastKey,
                CAPTURE_PAGE_SIZE
            );
            if (candidates.length === 0) {
                break;
            }
            const capture = await captureLineDeathsFn({
                repoName: repo.name,
                repoPath: repo.path,
                candidates,
                resolveAuthorId: resolver.resolve,
            });
            persistLineDeaths(db, capture.records);
            lastKey = candidates[candidates.length - 1] ?? null;
            candidateCount += candidates.length;
            totalFailed += capture.failedCandidates;
            capturedAny ||= capture.records.length > 0;
        }
        // Parity with ownership: candidates exist but nothing survived, so
        // either git failed under them or every deletion was a rename-edit;
        // reporting plain zeros would read as "no thrash" either way.
        if (totalFailed > 0 || (candidateCount > 0 && !capturedAny)) {
            process.stderr.write(
                `warning: rework attribution produced no line deaths for ${repo.name} across ${candidateCount} candidate commit(s) (${totalFailed} failed); rework lines may be undercounted.\n`
            );
        }
        recordCaptureMarker(db, repo.name, totalFailed);
        if (totalFailed > 0) {
            incompleteRepos.push(repo.name);
        }
    }
    return { incompleteRepos, unknownEmails: resolver.unknownEmails() };
}

function persistLineDeaths(
    db: CacheDatabase,
    records: (LineDeathRecord & { repo: string })[]
): void {
    if (records.length === 0) {
        return;
    }
    const rows: LineDeathInsertRow[] = records.map((record) => ({
        repo: record.repo,
        sha: record.sha,
        path: record.path,
        victimSha: record.victimSha,
        victimAuthorId: record.victimAuthorId,
        victimAuthoredAt: record.victimAuthoredAt,
        lines: record.lines,
    }));
    db.transaction((tx) => {
        for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
            tx.insert(lineDeaths)
                .values(rows.slice(start, start + INSERT_BATCH_SIZE))
                .onConflictDoNothing()
                .run();
        }
    });
}

function recordCaptureMarker(
    db: CacheDatabase,
    repoName: string,
    failedCandidates: number
): void {
    const capturedAt = Date.now();
    db.insert(reworkCaptures)
        .values({ repo: repoName, failedCandidates, capturedAt })
        .onConflictDoUpdate({
            target: reworkCaptures.repo,
            set: { failedCandidates, capturedAt },
        })
        .run();
}
