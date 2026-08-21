import { tryCatch } from "@spanical/utils";
import { blameFileLines, type BlamedLine } from "./blame";
import { runGit } from "./git";

export type DeletedRange = { start: number; count: number };

export type VictimBucket = {
    sha: string;
    email: string;
    name: string;
    authoredAt: number;
    lines: number;
};

export type LineDeathRecord = {
    sha: string;
    path: string;
    victimSha: string;
    victimAuthorId: number;
    victimAuthoredAt: number;
    lines: number;
};

export type LineDeathCandidate = { sha: string; path: string };

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/;
const BLAME_CONCURRENCY = 16;
const MILLISECONDS_PER_SECOND = 1000;

// -U0 hunk headers carry parent-side deleted ranges: "@@ -12,3 +10,1 @@" means
// three parent lines starting at 12 died; a bare "@@ -7 +9,2 @@" means one.
export function parseDeletedRanges(diff: string): DeletedRange[] {
    const ranges: DeletedRange[] = [];
    for (const line of diff.split("\n")) {
        const match = HUNK_HEADER_PATTERN.exec(line);
        const startGroup = match?.[1];
        if (match === null || startGroup === undefined) {
            continue;
        }
        const start = Number.parseInt(startGroup, 10);
        const count =
            match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
        if (count > 0) {
            ranges.push({ start, count });
        }
    }
    return ranges;
}

// Parent-side line numbers are 1-based and blame output is in file order, so
// blamed[start - 1 + offset] is the line the diff says died.
export function bucketDeletionsByVictim(
    ranges: DeletedRange[],
    blamed: BlamedLine[]
): VictimBucket[] {
    const buckets = new Map<string, VictimBucket>();
    for (const range of ranges) {
        for (let offset = 0; offset < range.count; offset += 1) {
            const entry = blamed[range.start - 1 + offset];
            if (entry === undefined) {
                continue;
            }
            const existing = buckets.get(entry.sha);
            if (existing) {
                existing.lines += 1;
            } else {
                buckets.set(entry.sha, {
                    sha: entry.sha,
                    email: entry.email,
                    name: entry.name,
                    authoredAt: entry.authoredAt,
                    lines: 1,
                });
            }
        }
    }
    return [...buckets.values()];
}

async function captureCandidate(
    repoPath: string,
    candidate: LineDeathCandidate,
    resolveAuthorId: (email: string, name: string) => number
): Promise<LineDeathRecord[] | null> {
    const parentRef = `${candidate.sha}^`;
    const { data: diff, error: diffError } = await tryCatch(
        runGit(
            ["diff", "-U0", parentRef, candidate.sha, "--", candidate.path],
            repoPath
        )
    );
    // Candidates always have deleted > 0, so they always have a parent; a
    // failing diff here means git could not read history (grafted or shallow
    // boundaries, corrupt objects), never a legitimate skip.
    if (diffError) {
        return null;
    }
    const ranges = parseDeletedRanges(diff);
    if (ranges.length === 0) {
        return [];
    }

    const blamed = await blameFileLines(repoPath, parentRef, candidate.path);
    if (blamed === null) {
        return null;
    }

    return bucketDeletionsByVictim(ranges, blamed).map((victim) => ({
        sha: candidate.sha,
        path: candidate.path,
        victimSha: victim.sha,
        victimAuthorId: resolveAuthorId(victim.email, victim.name),
        // Blame reports author-time in epoch seconds; every other timestamp
        // in the cache is Date.getTime() milliseconds.
        victimAuthoredAt: victim.authoredAt * MILLISECONDS_PER_SECOND,
        lines: victim.lines,
    }));
}

export type LineDeathCapture = {
    records: (LineDeathRecord & { repo: string })[];
    failedCandidates: number;
};

export async function captureLineDeaths(opts: {
    repoName: string;
    repoPath: string;
    candidates: LineDeathCandidate[];
    resolveAuthorId: (email: string, name: string) => number;
}): Promise<LineDeathCapture> {
    const records: (LineDeathRecord & { repo: string })[] = [];
    let failedCandidates = 0;
    for (
        let start = 0;
        start < opts.candidates.length;
        start += BLAME_CONCURRENCY
    ) {
        const chunk = opts.candidates.slice(start, start + BLAME_CONCURRENCY);
        const chunkResults = await Promise.all(
            chunk.map((candidate) =>
                captureCandidate(opts.repoPath, candidate, opts.resolveAuthorId)
            )
        );
        for (const group of chunkResults) {
            if (group === null) {
                failedCandidates += 1;
                continue;
            }
            for (const record of group) {
                records.push({ repo: opts.repoName, ...record });
            }
        }
    }
    return { records, failedCandidates };
}
