import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { and, countDistinct, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { authors, commitAuthors, commits, fileChanges } from "../cache/schema";
import type { Period } from "../window/types";
import type { DevPeriodRollup } from "./types";

const DAY_FORMAT = "yyyy-MM-dd";

type PeriodBounds = {
    start: number;
    end: number;
    repo: string | undefined;
    repos?: string[];
};

type ChurnEntry = { added: number; deleted: number; filesTouched: number };

function loadAuthorNames(db: CacheDatabase): Map<number, string> {
    const rows = db
        .select({ id: authors.id, canonicalName: authors.canonicalName })
        .from(authors)
        .all();
    return new Map(rows.map((row) => [row.id, row.canonicalName]));
}

function queryChurnAndFiles(
    db: CacheDatabase,
    bounds: PeriodBounds
): Map<number, ChurnEntry> {
    const rows = db
        .select({
            authorId: commitAuthors.authorId,
            added: sql<number>`coalesce(sum(${fileChanges.added} * ${commitAuthors.weight}), 0)`,
            deleted: sql<number>`coalesce(sum(${fileChanges.deleted} * ${commitAuthors.weight}), 0)`,
            filesTouched: countDistinct(fileChanges.path),
        })
        .from(commits)
        .innerJoin(commitAuthors, eq(commitAuthors.sha, commits.sha))
        .innerJoin(fileChanges, eq(fileChanges.sha, commits.sha))
        .where(
            and(
                gte(commits.authoredAt, bounds.start),
                lt(commits.authoredAt, bounds.end),
                eq(fileChanges.isBinary, false),
                eq(fileChanges.isMigration, false),
                bounds.repo ? eq(commits.repo, bounds.repo) : undefined,
                bounds.repos && bounds.repos.length > 0
                    ? inArray(commits.repo, bounds.repos)
                    : undefined
            )
        )
        .groupBy(commitAuthors.authorId)
        .all();
    return new Map(
        rows.map((row) => [
            row.authorId,
            {
                added: row.added,
                deleted: row.deleted,
                filesTouched: row.filesTouched,
            },
        ])
    );
}

function queryCommitCounts(
    db: CacheDatabase,
    bounds: PeriodBounds
): Map<number, number> {
    const rows = db
        .select({
            authorId: commitAuthors.authorId,
            commits: countDistinct(commits.sha),
        })
        .from(commits)
        .innerJoin(commitAuthors, eq(commitAuthors.sha, commits.sha))
        .where(
            and(
                gte(commits.authoredAt, bounds.start),
                lt(commits.authoredAt, bounds.end),
                bounds.repo ? eq(commits.repo, bounds.repo) : undefined,
                bounds.repos && bounds.repos.length > 0
                    ? inArray(commits.repo, bounds.repos)
                    : undefined
            )
        )
        .groupBy(commitAuthors.authorId)
        .all();
    return new Map(rows.map((row) => [row.authorId, row.commits]));
}

function queryActiveDays(
    db: CacheDatabase,
    bounds: PeriodBounds,
    timezone: string
): Map<number, number> {
    const rows = db
        .selectDistinct({
            authorId: commitAuthors.authorId,
            authoredAt: commits.authoredAt,
        })
        .from(commits)
        .innerJoin(commitAuthors, eq(commitAuthors.sha, commits.sha))
        .where(
            and(
                gte(commits.authoredAt, bounds.start),
                lt(commits.authoredAt, bounds.end),
                bounds.repo ? eq(commits.repo, bounds.repo) : undefined,
                bounds.repos && bounds.repos.length > 0
                    ? inArray(commits.repo, bounds.repos)
                    : undefined
            )
        )
        .all();

    const daysByAuthor = new Map<number, Set<string>>();
    for (const row of rows) {
        const day = format(new TZDate(row.authoredAt, timezone), DAY_FORMAT);
        const days = daysByAuthor.get(row.authorId) ?? new Set<string>();
        days.add(day);
        daysByAuthor.set(row.authorId, days);
    }

    const counts = new Map<number, number>();
    for (const [authorId, days] of daysByAuthor) {
        counts.set(authorId, days.size);
    }
    return counts;
}

export function aggregatePerDev(
    db: CacheDatabase,
    opts: {
        periods: Period[];
        timezone: string;
        repo?: string;
        repos?: string[];
    }
): DevPeriodRollup[] {
    const nameById = loadAuthorNames(db);
    const rollups: DevPeriodRollup[] = [];

    for (const period of opts.periods) {
        const bounds: PeriodBounds = {
            start: period.start.getTime(),
            end: period.end.getTime(),
            repo: opts.repo,
            repos: opts.repos,
        };
        const churn = queryChurnAndFiles(db, bounds);
        const commitCounts = queryCommitCounts(db, bounds);
        const activeDays = queryActiveDays(db, bounds, opts.timezone);

        const authorIds = [
            ...new Set([
                ...churn.keys(),
                ...commitCounts.keys(),
                ...activeDays.keys(),
            ]),
        ].sort((left, right) => left - right);

        for (const authorId of authorIds) {
            const author = nameById.get(authorId);
            if (author === undefined) {
                throw new Error(
                    `Aggregation credited author ${authorId} has no authors row; cache is inconsistent.`
                );
            }
            const churnEntry = churn.get(authorId);
            const added = churnEntry?.added ?? 0;
            const deleted = churnEntry?.deleted ?? 0;
            const filesTouched = churnEntry?.filesTouched ?? 0;
            const commitCount = commitCounts.get(authorId) ?? 0;
            const throughput = added + deleted;

            rollups.push({
                period: period.label,
                authorId,
                author,
                commits: commitCount,
                added,
                deleted,
                net: added - deleted,
                throughput,
                filesTouched,
                avgCommitSize:
                    commitCount === 0 ? null : throughput / commitCount,
                activeDays: activeDays.get(authorId) ?? 0,
            });
        }
    }

    return rollups;
}
