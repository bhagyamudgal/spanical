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
const TIP_MONTH_FORMAT = "yyyy-MM";

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

async function tipCommitMonth(
    repoPath: string,
    tipSha: string,
    timezone: string
): Promise<string> {
    const iso = (
        await runGit(["show", "-s", "--format=%cI", tipSha], repoPath)
    ).trim();
    return format(new TZDate(new Date(iso).getTime(), timezone), TIP_MONTH_FORMAT);
}

async function ensureTipSnapshot(
    db: CacheDatabase,
    repo: RepoRef,
    tipSha: string,
    timezone: string
): Promise<void> {
    const existing = db
        .select({ sha: sccSnapshots.sha })
        .from(sccSnapshots)
        .where(
            and(eq(sccSnapshots.repo, repo.name), eq(sccSnapshots.sha, tipSha))
        )
        .get();
    if (existing) {
        return;
    }
    const sccBinary = await resolveSccBinary();
    const month = await tipCommitMonth(repo.path, tipSha, timezone);
    await snapshotSha(db, repo, month, tipSha, sccBinary);
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
        await ensureTipSnapshot(db, repo, tipSha, run.tz);
        await blameRepoOwnership(
            db,
            resolver,
            repo,
            tipSha,
            config.hotspot.minFileLines
        );
    }
}
