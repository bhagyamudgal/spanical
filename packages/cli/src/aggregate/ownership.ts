import { and, eq, inArray } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { authors, extractions, fileOwnership } from "../cache/schema";
import type {
    BusFactorRow,
    OwnershipAggregation,
    OwnershipAuthorShare,
    OwnershipRow,
} from "./types";

const PRIMARY_OWNER_THRESHOLD = 0.5;
const ROOT_DIRECTORY = ".";
const PATH_SEPARATOR = "/";

type OwnershipQueryRow = {
    repo: string;
    path: string;
    author: string;
    survivingLines: number;
};

type FileGroup = {
    repo: string;
    path: string;
    linesByAuthor: Map<string, number>;
    total: number;
};

type BusFactorGroup = {
    repo: string;
    dir: string;
    count: number;
    owners: Set<string>;
};

function parentDirectory(path: string): string {
    const lastSeparator = path.lastIndexOf(PATH_SEPARATOR);
    return lastSeparator === -1 ? ROOT_DIRECTORY : path.slice(0, lastSeparator);
}

function groupByFile(rows: OwnershipQueryRow[]): FileGroup[] {
    const groups = new Map<string, FileGroup>();
    for (const row of rows) {
        const key = `${row.repo}\n${row.path}`;
        const group = groups.get(key) ?? {
            repo: row.repo,
            path: row.path,
            linesByAuthor: new Map<string, number>(),
            total: 0,
        };
        group.linesByAuthor.set(
            row.author,
            (group.linesByAuthor.get(row.author) ?? 0) + row.survivingLines
        );
        group.total += row.survivingLines;
        groups.set(key, group);
    }
    return [...groups.values()];
}

function toFileRow(
    group: FileGroup,
    busFactorThreshold: number
): OwnershipRow | null {
    if (group.total === 0) {
        return null;
    }
    const shares: OwnershipAuthorShare[] = [...group.linesByAuthor.entries()]
        .map(([author, survivingLines]) => ({
            author,
            survivingLines,
            share: survivingLines / group.total,
        }))
        .sort(
            (left, right) =>
                right.survivingLines - left.survivingLines ||
                left.author.localeCompare(right.author)
        );

    const leader = shares[0];
    if (leader === undefined) {
        return null;
    }
    const isSoleOwned = leader.share >= busFactorThreshold;

    return {
        repo: group.repo,
        path: group.path,
        totalLines: group.total,
        ownerCount: shares.length,
        primaryOwner:
            leader.share > PRIMARY_OWNER_THRESHOLD ? leader.author : null,
        primaryShare: leader.share,
        isSoleOwned,
        soleOwner: isSoleOwned ? leader.author : null,
        shares,
    };
}

function buildFileRows(
    rows: OwnershipQueryRow[],
    busFactorThreshold: number
): OwnershipRow[] {
    const fileRows: OwnershipRow[] = [];
    for (const group of groupByFile(rows)) {
        const fileRow = toFileRow(group, busFactorThreshold);
        if (fileRow !== null) {
            fileRows.push(fileRow);
        }
    }
    return fileRows.sort(
        (left, right) =>
            right.primaryShare - left.primaryShare ||
            left.repo.localeCompare(right.repo) ||
            left.path.localeCompare(right.path)
    );
}

function buildBusFactor(files: OwnershipRow[]): BusFactorRow[] {
    const groups = new Map<string, BusFactorGroup>();
    for (const file of files) {
        if (!file.isSoleOwned || file.soleOwner === null) {
            continue;
        }
        const dir = parentDirectory(file.path);
        const key = `${file.repo}\n${dir}`;
        const group = groups.get(key) ?? {
            repo: file.repo,
            dir,
            count: 0,
            owners: new Set<string>(),
        };
        group.count += 1;
        group.owners.add(file.soleOwner);
        groups.set(key, group);
    }
    return [...groups.values()]
        .map((group) => ({
            repo: group.repo,
            dir: group.dir,
            soleOwnedCount: group.count,
            owners: [...group.owners].sort((left, right) =>
                left.localeCompare(right)
            ),
        }))
        .sort(
            (left, right) =>
                right.soleOwnedCount - left.soleOwnedCount ||
                left.repo.localeCompare(right.repo) ||
                left.dir.localeCompare(right.dir)
        );
}

export function aggregateOwnership(
    db: CacheDatabase,
    opts: { repos: string[]; busFactorThreshold: number }
): OwnershipAggregation {
    if (opts.repos.length === 0) {
        return { files: [], busFactor: [] };
    }

    const rows = db
        .select({
            repo: fileOwnership.repo,
            path: fileOwnership.path,
            author: authors.canonicalName,
            survivingLines: fileOwnership.survivingLines,
        })
        .from(fileOwnership)
        .innerJoin(
            extractions,
            and(
                eq(extractions.repo, fileOwnership.repo),
                eq(extractions.tipSha, fileOwnership.headSha)
            )
        )
        .innerJoin(authors, eq(authors.id, fileOwnership.authorId))
        .where(inArray(fileOwnership.repo, opts.repos))
        .all();

    const files = buildFileRows(rows, opts.busFactorThreshold);
    return { files, busFactor: buildBusFactor(files) };
}
