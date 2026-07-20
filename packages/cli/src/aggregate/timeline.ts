import { tryCatch } from "@spanical/utils";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { commitAuthors, commits, fileChanges } from "../cache/schema";
import { runGit } from "../extract/git";
import type { Period, ResolvedWindow } from "../window/types";
import { aggregatePerPeriod } from "./per-period";
import type {
    DominantCommitSubtype,
    PeriodRollup,
    TimelineEvent,
    TimelinePeriod,
} from "./types";

const DOMINANT_COMMIT_SHARE = 0.4;
const LANDING_ADD_RATIO = 0.7;
const REMOVAL_ADD_RATIO = 0.3;
const SPIKE_MULTIPLIER = 2.0;
const REMOVAL_MIN_SHARE = 0.5;

const SHORT_SHA_LENGTH = 7;
const PERCENT_SCALE = 100;
const MULTIPLE_DECIMALS = 1;
const SHARE_DECIMALS = 0;
const BUSIEST_LABEL = "busiest period";
const REMOVAL_LABEL = "net removal";

type TimelineRepo = { name: string; path: string };

type WindowBounds = { start: number; end: number };

type CommitChurnRow = {
    sha: string;
    repo: string;
    authoredAt: number;
    added: number;
    deleted: number;
};

type ActiveDevRow = { authorId: number; authoredAt: number };

type DominantCommit = {
    sha: string;
    repo: string;
    shortSha: string;
    share: number;
    subtype: DominantCommitSubtype;
};

function windowBounds(periods: Period[]): WindowBounds {
    const starts = periods.map((period) => period.start.getTime());
    const ends = periods.map((period) => period.end.getTime());
    return { start: Math.min(...starts), end: Math.max(...ends) };
}

function periodIndexOf(periods: Period[], timestamp: number): number {
    for (let index = 0; index < periods.length; index++) {
        const period = periods[index];
        if (
            period !== undefined &&
            timestamp >= period.start.getTime() &&
            timestamp < period.end.getTime()
        ) {
            return index;
        }
    }
    return -1;
}

function medianThroughput(perPeriod: PeriodRollup[]): number {
    const values = perPeriod
        .map((row) => row.throughput)
        .sort((left, right) => left - right);
    if (values.length === 0) {
        return 0;
    }
    const mid = Math.floor(values.length / 2);
    if (values.length % 2 === 1) {
        return values[mid] ?? 0;
    }
    return ((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2;
}

function busiestPeriodLabel(perPeriod: PeriodRollup[]): string | null {
    let busiest: PeriodRollup | null = null;
    for (const row of perPeriod) {
        if (
            row.throughput > 0 &&
            (busiest === null || row.throughput > busiest.throughput)
        ) {
            busiest = row;
        }
    }
    return busiest?.period ?? null;
}

function queryCommitChurn(
    db: CacheDatabase,
    bounds: WindowBounds
): CommitChurnRow[] {
    return db
        .select({
            sha: commits.sha,
            repo: commits.repo,
            authoredAt: commits.authoredAt,
            added: sql<number>`coalesce(sum(${fileChanges.added}), 0)`,
            deleted: sql<number>`coalesce(sum(${fileChanges.deleted}), 0)`,
        })
        .from(commits)
        .innerJoin(fileChanges, eq(fileChanges.sha, commits.sha))
        .where(
            and(
                gte(commits.authoredAt, bounds.start),
                lt(commits.authoredAt, bounds.end),
                eq(fileChanges.isBinary, false),
                eq(fileChanges.isMigration, false)
            )
        )
        .groupBy(commits.sha, commits.repo, commits.authoredAt)
        .all();
}

function queryActiveDevRows(
    db: CacheDatabase,
    bounds: WindowBounds
): ActiveDevRow[] {
    return db
        .selectDistinct({
            authorId: commitAuthors.authorId,
            authoredAt: commits.authoredAt,
        })
        .from(commits)
        .innerJoin(commitAuthors, eq(commitAuthors.sha, commits.sha))
        .where(
            and(
                gte(commits.authoredAt, bounds.start),
                lt(commits.authoredAt, bounds.end)
            )
        )
        .all();
}

function countActiveDevsByPeriod(
    rows: ActiveDevRow[],
    periods: Period[]
): number[] {
    const authorsByPeriod = periods.map(() => new Set<number>());
    for (const row of rows) {
        const index = periodIndexOf(periods, row.authoredAt);
        authorsByPeriod[index]?.add(row.authorId);
    }
    return authorsByPeriod.map((authorIds) => authorIds.size);
}

function subtypeOf(added: number, deleted: number): DominantCommitSubtype {
    const churn = added + deleted;
    if (churn === 0) {
        return "restructure";
    }
    const addShare = added / churn;
    if (addShare >= LANDING_ADD_RATIO) {
        return "landing";
    }
    if (addShare <= REMOVAL_ADD_RATIO) {
        return "removal";
    }
    return "restructure";
}

function detectDominantCommits(
    commitChurn: CommitChurnRow[],
    perPeriod: PeriodRollup[],
    periods: Period[]
): Map<number, DominantCommit[]> {
    const byPeriod = new Map<number, DominantCommit[]>();
    for (const row of commitChurn) {
        const index = periodIndexOf(periods, row.authoredAt);
        if (index === -1) {
            continue;
        }
        const throughput = perPeriod[index]?.throughput ?? 0;
        if (throughput <= 0) {
            continue;
        }
        const churn = row.added + row.deleted;
        if (churn < DOMINANT_COMMIT_SHARE * throughput) {
            continue;
        }
        const dominant: DominantCommit = {
            sha: row.sha,
            repo: row.repo,
            shortSha: row.sha.slice(0, SHORT_SHA_LENGTH),
            share: churn / throughput,
            subtype: subtypeOf(row.added, row.deleted),
        };
        const existing = byPeriod.get(index) ?? [];
        existing.push(dominant);
        byPeriod.set(index, existing);
    }
    return byPeriod;
}

async function fetchSubject(
    dominant: DominantCommit,
    pathByRepo: Map<string, string>
): Promise<string> {
    const repoPath = pathByRepo.get(dominant.repo);
    if (repoPath === undefined) {
        return dominant.shortSha;
    }
    const { data, error } = await tryCatch(
        runGit(["show", "-s", "--format=%s", dominant.sha], repoPath)
    );
    if (error !== null) {
        return dominant.shortSha;
    }
    const subject = data.trim();
    return subject.length > 0 ? subject : dominant.shortSha;
}

async function fetchDominantSubjects(
    dominantByPeriod: Map<number, DominantCommit[]>,
    repos: TimelineRepo[]
): Promise<Map<string, string>> {
    const pathByRepo = new Map(repos.map((repo) => [repo.name, repo.path]));
    const dominants = [...dominantByPeriod.values()].flat();
    const entries = await Promise.all(
        dominants.map(async (dominant) => {
            const subject = await fetchSubject(dominant, pathByRepo);
            return [dominant.sha, subject] as const;
        })
    );
    return new Map(entries);
}

function spikeLabel(multiple: number): string {
    return `churn spike (${multiple.toFixed(MULTIPLE_DECIMALS)}x median)`;
}

function dominantLabel(dominant: DominantCommit, subject: string): string {
    const percent = (dominant.share * PERCENT_SCALE).toFixed(SHARE_DECIMALS);
    return `${dominant.subtype} ${dominant.shortSha} "${subject}" (${percent}% of churn)`;
}

function buildEvents(input: {
    rollup: PeriodRollup;
    median: number;
    busiestLabel: string | null;
    dominants: DominantCommit[];
    subjects: Map<string, string>;
}): TimelineEvent[] {
    const {
        rollup,
        median,
        busiestLabel: busiest,
        dominants,
        subjects,
    } = input;
    const events: TimelineEvent[] = [];

    if (busiest !== null && rollup.period === busiest) {
        events.push({ kind: "busiest", label: BUSIEST_LABEL });
    }
    if (median > 0 && rollup.throughput >= SPIKE_MULTIPLIER * median) {
        const multiple = rollup.throughput / median;
        events.push({
            kind: "churn-spike",
            label: spikeLabel(multiple),
            multiple,
        });
    }
    if (rollup.net < 0 && rollup.throughput >= REMOVAL_MIN_SHARE * median) {
        events.push({ kind: "removal", label: REMOVAL_LABEL });
    }
    for (const dominant of dominants) {
        const subject = subjects.get(dominant.sha) ?? dominant.shortSha;
        events.push({
            kind: "dominant-commit",
            label: dominantLabel(dominant, subject),
            sha: dominant.shortSha,
            subject,
            share: dominant.share,
            subtype: dominant.subtype,
        });
    }
    return events;
}

export async function aggregateTimeline(
    db: CacheDatabase,
    opts: { window: ResolvedWindow; repos: TimelineRepo[] }
): Promise<TimelinePeriod[]> {
    const { periods } = opts.window;
    if (periods.length === 0) {
        return [];
    }

    const perPeriod = aggregatePerPeriod(db, { periods });
    const median = medianThroughput(perPeriod);
    const busiest = busiestPeriodLabel(perPeriod);
    const bounds = windowBounds(periods);

    const activeDevsByPeriod = countActiveDevsByPeriod(
        queryActiveDevRows(db, bounds),
        periods
    );
    const dominantByPeriod = detectDominantCommits(
        queryCommitChurn(db, bounds),
        perPeriod,
        periods
    );
    const subjects = await fetchDominantSubjects(dominantByPeriod, opts.repos);

    return perPeriod.map((rollup, index) => ({
        period: rollup.period,
        net: rollup.net,
        throughput: rollup.throughput,
        commits: rollup.commits,
        activeDevs: activeDevsByPeriod[index] ?? 0,
        events: buildEvents({
            rollup,
            median,
            busiestLabel: busiest,
            dominants: dominantByPeriod.get(index) ?? [],
            subjects,
        }),
    }));
}
