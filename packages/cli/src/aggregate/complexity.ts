import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import {
    commitAuthors,
    commits,
    fileChanges,
    sccSnapshots,
} from "../cache/schema";
import { generatePeriods } from "../window";
import type { ResolvedWindow } from "../window/types";
import { aggregateHotspots } from "./hotspots";
import type {
    ComplexityAttribution,
    DevComplexityRollup,
    DevPeriodRollup,
} from "./types";

export const HOTSPOT_CONTRIBUTION_TOP_N = 20;

const MONTH_FORMAT = "yyyy-MM";
const KEY_SEPARATOR = "\n";

type ComplexityAttributionOptions = {
    window: ResolvedWindow;
    windowStart: Date;
    repos: string[];
    timezone: string;
    minFileLines: number;
    busFactorThreshold: number;
    windowEndShas: Map<string, string>;
    baselineShas: Map<string, string>;
    perDev: DevPeriodRollup[];
};

type FileMonthDelta = {
    repo: string;
    path: string;
    month: string;
    delta: number;
};

type ChurnRow = {
    repo: string;
    path: string;
    authorId: number;
    weight: number;
    added: number | null;
    deleted: number | null;
    authoredAt: number;
};

function fileKey(repo: string, path: string): string {
    return `${repo}${KEY_SEPARATOR}${path}`;
}

function fileMonthKey(repo: string, path: string, month: string): string {
    return `${repo}${KEY_SEPARATOR}${path}${KEY_SEPARATOR}${month}`;
}

function complexityBySha(
    db: CacheDatabase,
    repo: string,
    sha: string
): Map<string, number> {
    const rows = db
        .select({
            path: sccSnapshots.path,
            complexity: sccSnapshots.complexity,
        })
        .from(sccSnapshots)
        .where(and(eq(sccSnapshots.repo, repo), eq(sccSnapshots.sha, sha)))
        .all();
    return new Map(rows.map((row) => [row.path, row.complexity]));
}

function computeFileMonthDeltas(
    db: CacheDatabase,
    repo: string,
    firstMonth: string,
    lastMonth: string,
    baselineSha: string | undefined
): FileMonthDelta[] {
    const baseline =
        baselineSha === undefined
            ? new Map<string, number>()
            : complexityBySha(db, repo, baselineSha);

    const rows = db
        .select({
            month: sccSnapshots.month,
            path: sccSnapshots.path,
            complexity: sccSnapshots.complexity,
        })
        .from(sccSnapshots)
        .where(
            and(
                eq(sccSnapshots.repo, repo),
                eq(sccSnapshots.isBoundary, true),
                gte(sccSnapshots.month, firstMonth),
                lte(sccSnapshots.month, lastMonth)
            )
        )
        .all();

    const complexityByMonth = new Map<string, Map<string, number>>();
    for (const row of rows) {
        const byPath =
            complexityByMonth.get(row.month) ?? new Map<string, number>();
        byPath.set(row.path, row.complexity);
        complexityByMonth.set(row.month, byPath);
    }

    const months = [...complexityByMonth.keys()].sort();
    const deltas: FileMonthDelta[] = [];
    let previous = baseline;
    for (const month of months) {
        const current =
            complexityByMonth.get(month) ?? new Map<string, number>();
        const paths = new Set([...current.keys(), ...previous.keys()]);
        for (const path of paths) {
            const delta = (current.get(path) ?? 0) - (previous.get(path) ?? 0);
            if (delta !== 0) {
                deltas.push({ repo, path, month, delta });
            }
        }
        previous = current;
    }
    return deltas;
}

function loadChurnRows(
    db: CacheDatabase,
    repos: string[],
    churnStart: Date,
    windowEnd: Date
): ChurnRow[] {
    return db
        .select({
            repo: commits.repo,
            path: fileChanges.path,
            authorId: commitAuthors.authorId,
            weight: commitAuthors.weight,
            added: fileChanges.added,
            deleted: fileChanges.deleted,
            authoredAt: commits.authoredAt,
        })
        .from(commits)
        .innerJoin(commitAuthors, eq(commitAuthors.sha, commits.sha))
        .innerJoin(fileChanges, eq(fileChanges.sha, commits.sha))
        .where(
            and(
                inArray(commits.repo, repos),
                gte(commits.authoredAt, churnStart.getTime()),
                lt(commits.authoredAt, windowEnd.getTime()),
                eq(fileChanges.isBinary, false),
                eq(fileChanges.isMigration, false)
            )
        )
        .all();
}

type ChurnIndex = {
    byFileMonth: Map<string, Map<number, number>>;
    totalByDev: Map<number, number>;
    hotspotByDev: Map<number, number>;
    addedByDev: Map<number, number>;
};

function indexChurn(
    rows: ChurnRow[],
    timezone: string,
    hotspotFileKeys: Set<string>
): ChurnIndex {
    const byFileMonth = new Map<string, Map<number, number>>();
    const totalByDev = new Map<number, number>();
    const hotspotByDev = new Map<number, number>();
    // Weighted added lines over the same month-aligned span as the attributed
    // complexity, so complexityPerAddedLine's numerator and denominator match.
    const addedByDev = new Map<number, number>();

    for (const row of rows) {
        const month = format(
            new TZDate(row.authoredAt, timezone),
            MONTH_FORMAT
        );
        const churn = ((row.added ?? 0) + (row.deleted ?? 0)) * row.weight;
        const added = (row.added ?? 0) * row.weight;

        totalByDev.set(
            row.authorId,
            (totalByDev.get(row.authorId) ?? 0) + churn
        );
        addedByDev.set(
            row.authorId,
            (addedByDev.get(row.authorId) ?? 0) + added
        );
        if (hotspotFileKeys.has(fileKey(row.repo, row.path))) {
            hotspotByDev.set(
                row.authorId,
                (hotspotByDev.get(row.authorId) ?? 0) + churn
            );
        }

        const key = fileMonthKey(row.repo, row.path, month);
        const devMap = byFileMonth.get(key) ?? new Map<number, number>();
        devMap.set(row.authorId, (devMap.get(row.authorId) ?? 0) + churn);
        byFileMonth.set(key, devMap);
    }

    return { byFileMonth, totalByDev, hotspotByDev, addedByDev };
}

type Attribution = {
    addedByDev: Map<number, number>;
    removedByDev: Map<number, number>;
    unattributed: number;
};

function attributeDeltas(
    deltas: FileMonthDelta[],
    churnByFileMonth: Map<string, Map<number, number>>
): Attribution {
    const addedByDev = new Map<number, number>();
    const removedByDev = new Map<number, number>();
    let unattributed = 0;

    for (const entry of deltas) {
        const devChurn = churnByFileMonth.get(
            fileMonthKey(entry.repo, entry.path, entry.month)
        );
        let total = 0;
        if (devChurn !== undefined) {
            for (const churn of devChurn.values()) {
                total += churn;
            }
        }
        if (devChurn === undefined || total === 0) {
            unattributed += entry.delta;
            continue;
        }
        for (const [authorId, churn] of devChurn) {
            const attributed = entry.delta * (churn / total);
            if (attributed > 0) {
                addedByDev.set(
                    authorId,
                    (addedByDev.get(authorId) ?? 0) + attributed
                );
            } else if (attributed < 0) {
                removedByDev.set(
                    authorId,
                    (removedByDev.get(authorId) ?? 0) - attributed
                );
            }
        }
    }

    return { addedByDev, removedByDev, unattributed };
}

export function aggregateComplexityAttribution(
    db: CacheDatabase,
    opts: ComplexityAttributionOptions
): ComplexityAttribution {
    if (opts.repos.length === 0) {
        return { devs: [], unattributed: 0 };
    }

    const monthlyPeriods = generatePeriods(
        opts.windowStart,
        opts.window.end,
        "month",
        opts.timezone
    );
    const firstPeriod = monthlyPeriods[0];
    const lastPeriod = monthlyPeriods[monthlyPeriods.length - 1];
    if (firstPeriod === undefined || lastPeriod === undefined) {
        return { devs: [], unattributed: 0 };
    }

    const deltas = opts.repos.flatMap((repo) =>
        computeFileMonthDeltas(
            db,
            repo,
            firstPeriod.label,
            lastPeriod.label,
            opts.baselineShas.get(repo)
        )
    );

    const hotspots = aggregateHotspots(db, {
        window: opts.window,
        repos: opts.repos,
        minFileLines: opts.minFileLines,
        busFactorThreshold: opts.busFactorThreshold,
        windowEndShas: opts.windowEndShas,
    });
    const hotspotFileKeys = new Set(
        hotspots
            .slice(0, HOTSPOT_CONTRIBUTION_TOP_N)
            .map((hotspot) => fileKey(hotspot.repo, hotspot.path))
    );

    // Monthly deltas are attributed by full-calendar-month churn so a delta and
    // the churn that caused it cover the same span even for a mid-month start.
    const churn = indexChurn(
        loadChurnRows(db, opts.repos, firstPeriod.start, opts.window.end),
        opts.timezone,
        hotspotFileKeys
    );
    const { addedByDev, removedByDev, unattributed } = attributeDeltas(
        deltas,
        churn.byFileMonth
    );

    const contributorIds = new Set(opts.perDev.map((dev) => dev.authorId));
    let unattributedTotal = unattributed;
    for (const [authorId, added] of addedByDev) {
        if (!contributorIds.has(authorId)) {
            unattributedTotal += added;
        }
    }
    for (const [authorId, removed] of removedByDev) {
        if (!contributorIds.has(authorId)) {
            unattributedTotal -= removed;
        }
    }

    const devs: DevComplexityRollup[] = opts.perDev.map((dev) => {
        const complexityAdded = addedByDev.get(dev.authorId) ?? 0;
        const complexityRemoved = removedByDev.get(dev.authorId) ?? 0;
        const totalChurn = churn.totalByDev.get(dev.authorId) ?? 0;
        const hotspotChurn = churn.hotspotByDev.get(dev.authorId) ?? 0;
        const addedLines = churn.addedByDev.get(dev.authorId) ?? 0;
        return {
            author: dev.author,
            authorId: dev.authorId,
            complexityAdded,
            complexityRemoved,
            complexityNet: complexityAdded - complexityRemoved,
            complexityPerAddedLine:
                addedLines === 0 ? null : complexityAdded / addedLines,
            hotspotContribution:
                totalChurn === 0 ? null : hotspotChurn / totalChurn,
        };
    });

    return { devs, unattributed: unattributedTotal };
}
