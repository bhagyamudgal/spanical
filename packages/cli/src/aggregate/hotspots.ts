import { and, countDistinct, eq, gte, inArray, lt } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { commits, fileChanges, sccSnapshots } from "../cache/schema";
import type { ResolvedWindow } from "../window/types";
import { aggregateOwnership } from "./ownership";
import type { HotspotRow } from "./types";

type HotspotOptions = {
    window: ResolvedWindow;
    repos: string[];
    minFileLines: number;
    busFactorThreshold: number;
    windowEndShas: Map<string, string>;
};
type Candidate = {
    repo: string;
    path: string;
    changeFrequency: number;
    complexity: number;
    ownerCount: number;
};
type Extent = { min: number; max: number };
type Extents = { frequency: Extent; complexity: Extent };

function fileKey(repo: string, path: string): string {
    return `${repo}\n${path}`;
}

function changeFrequencyByFile(
    db: CacheDatabase,
    window: ResolvedWindow,
    repos: string[]
): Map<string, number> {
    const rows = db
        .select({
            repo: fileChanges.repo,
            path: fileChanges.path,
            changeFrequency: countDistinct(commits.sha),
        })
        .from(fileChanges)
        .innerJoin(commits, eq(commits.sha, fileChanges.sha))
        .where(
            and(
                inArray(fileChanges.repo, repos),
                eq(fileChanges.isBinary, false),
                eq(fileChanges.isMigration, false),
                window.start !== null
                    ? gte(commits.authoredAt, window.start.getTime())
                    : undefined,
                lt(commits.authoredAt, window.end.getTime())
            )
        )
        .groupBy(fileChanges.repo, fileChanges.path)
        .all();

    return new Map(
        rows.map((row) => [fileKey(row.repo, row.path), row.changeFrequency])
    );
}

function complexityByPath(
    db: CacheDatabase,
    repo: string,
    windowEndSha: string,
    minFileLines: number
): Map<string, number> {
    const rows = db
        .select({
            path: sccSnapshots.path,
            code: sccSnapshots.code,
            complexity: sccSnapshots.complexity,
        })
        .from(sccSnapshots)
        .where(
            and(eq(sccSnapshots.repo, repo), eq(sccSnapshots.sha, windowEndSha))
        )
        .all();

    const byPath = new Map<string, number>();
    for (const row of rows) {
        if (row.code < minFileLines) {
            continue;
        }
        byPath.set(row.path, row.complexity);
    }
    return byPath;
}

function ownerCountByFile(
    db: CacheDatabase,
    repos: string[],
    busFactorThreshold: number
): Map<string, number> {
    const { files } = aggregateOwnership(db, { repos, busFactorThreshold });
    return new Map(
        files.map((file) => [fileKey(file.repo, file.path), file.ownerCount])
    );
}

function collectCandidates(
    db: CacheDatabase,
    opts: HotspotOptions
): Candidate[] {
    const frequency = changeFrequencyByFile(db, opts.window, opts.repos);
    const ownerCounts = ownerCountByFile(
        db,
        opts.repos,
        opts.busFactorThreshold
    );

    const candidates: Candidate[] = [];
    for (const repo of opts.repos) {
        const windowEndSha = opts.windowEndShas.get(repo);
        if (windowEndSha === undefined) {
            continue;
        }
        const complexity = complexityByPath(
            db,
            repo,
            windowEndSha,
            opts.minFileLines
        );
        for (const [path, complexityValue] of complexity) {
            const key = fileKey(repo, path);
            const changeFrequency = frequency.get(key);
            if (changeFrequency === undefined) {
                continue;
            }
            candidates.push({
                repo,
                path,
                changeFrequency,
                complexity: complexityValue,
                ownerCount: ownerCounts.get(key) ?? 0,
            });
        }
    }
    return candidates;
}

function computeExtents(candidates: Candidate[]): Extents {
    let minFrequency = Number.POSITIVE_INFINITY;
    let maxFrequency = Number.NEGATIVE_INFINITY;
    let minComplexity = Number.POSITIVE_INFINITY;
    let maxComplexity = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
        minFrequency = Math.min(minFrequency, candidate.changeFrequency);
        maxFrequency = Math.max(maxFrequency, candidate.changeFrequency);
        minComplexity = Math.min(minComplexity, candidate.complexity);
        maxComplexity = Math.max(maxComplexity, candidate.complexity);
    }
    return {
        frequency: { min: minFrequency, max: maxFrequency },
        complexity: { min: minComplexity, max: maxComplexity },
    };
}

function normalize(value: number, extent: Extent): number {
    if (extent.max === extent.min) {
        return 0;
    }
    return (value - extent.min) / (extent.max - extent.min);
}

export function aggregateHotspots(
    db: CacheDatabase,
    opts: HotspotOptions
): HotspotRow[] {
    if (opts.repos.length === 0) {
        return [];
    }

    const candidates = collectCandidates(db, opts);
    if (candidates.length === 0) {
        return [];
    }

    const extents = computeExtents(candidates);
    return candidates
        .map((candidate) => {
            const freqNorm = normalize(
                candidate.changeFrequency,
                extents.frequency
            );
            const cxNorm = normalize(candidate.complexity, extents.complexity);
            return {
                repo: candidate.repo,
                path: candidate.path,
                changeFrequency: candidate.changeFrequency,
                complexity: candidate.complexity,
                freqNorm,
                cxNorm,
                score: freqNorm * cxNorm,
                ownerCount: candidate.ownerCount,
            };
        })
        .sort(
            (left, right) =>
                right.score - left.score ||
                left.repo.localeCompare(right.repo) ||
                left.path.localeCompare(right.path)
        );
}
