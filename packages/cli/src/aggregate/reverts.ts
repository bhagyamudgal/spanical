import { and, eq, gte, inArray, like, lt } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { authorGithubLogins, authors, tickets } from "../cache/schema";
import { TICKET_KIND } from "../github/rows";
import { creditedColumns } from "./attribution";
import type { TicketAttribution } from "./types";

// GitHub's revert button produces exactly this title. The capture is greedy so
// Revert "Revert "X"" unwraps one layer at a time rather than matching X, and
// the match is case-insensitive to agree with the SQL prefilter below, which
// SQLite evaluates case-insensitively whether or not that was asked for.
const REVERT_TITLE = /^Revert "(.+)"$/i;
const REVERT_TITLE_PREFIX = 'Revert "%';

export type RevertTally = {
    byAuthor: Map<number, { author: string; reverted: number }>;
    matched: number;
    unmatched: number;
};

type RevertOptions = {
    repos: string[];
    start: number;
    end: number;
    attribution: TicketAttribution;
};

type RevertPullRequest = { repo: string; createdAt: number; reverted: string };
type Candidate = {
    createdAt: number;
    authorId: number | null;
    author: string | null;
    isBot: boolean;
};

function candidateKey(repo: string, title: string): string {
    return `${repo}\n${title}`;
}

function readRevertPullRequests(
    db: CacheDatabase,
    opts: RevertOptions
): RevertPullRequest[] {
    const rows = db
        .select({
            repo: tickets.repo,
            title: tickets.title,
            createdAt: tickets.createdAt,
        })
        .from(tickets)
        .where(
            and(
                inArray(tickets.repo, opts.repos),
                eq(tickets.kind, TICKET_KIND.pullRequest),
                gte(tickets.mergedAt, opts.start),
                lt(tickets.mergedAt, opts.end),
                like(tickets.title, REVERT_TITLE_PREFIX)
            )
        )
        .all();

    const reverts: RevertPullRequest[] = [];
    for (const row of rows) {
        // LIKE cannot check the closing quote, so a title with no reverted name
        // to extract is not a revert reference at all and drops out here.
        const reverted = REVERT_TITLE.exec(row.title)?.[1];
        if (reverted === undefined) {
            continue;
        }
        reverts.push({
            repo: row.repo,
            createdAt: row.createdAt,
            reverted,
        });
    }
    return reverts;
}

function readCandidates(
    db: CacheDatabase,
    opts: RevertOptions,
    titles: string[]
): Map<string, Candidate[]> {
    const credited = creditedColumns(opts.attribution);
    const rows = db
        .select({
            repo: tickets.repo,
            title: tickets.title,
            createdAt: tickets.createdAt,
            authorId: authors.id,
            author: authors.canonicalName,
            isBot: credited.isBot,
        })
        .from(tickets)
        .leftJoin(
            authorGithubLogins,
            eq(authorGithubLogins.login, credited.login)
        )
        .leftJoin(authors, eq(authors.id, authorGithubLogins.authorId))
        .where(
            and(
                inArray(tickets.repo, opts.repos),
                eq(tickets.kind, TICKET_KIND.pullRequest),
                inArray(tickets.title, titles)
            )
        )
        .all();

    const byKey = new Map<string, Candidate[]>();
    for (const row of rows) {
        const key = candidateKey(row.repo, row.title);
        const candidates = byKey.get(key) ?? [];
        candidates.push({
            createdAt: row.createdAt,
            authorId: row.authorId,
            author: row.author,
            isBot: row.isBot,
        });
        byKey.set(key, candidates);
    }
    for (const candidates of byKey.values()) {
        candidates.sort((left, right) => left.createdAt - right.createdAt);
    }
    return byKey;
}

// The reverted title is not unique, so the newest pull request carrying it that
// already existed when the revert was opened is the only defensible pairing.
function pairCandidate(
    candidates: Candidate[] | undefined,
    revertedAt: number
): Candidate | null {
    if (candidates === undefined) {
        return null;
    }
    let paired: Candidate | null = null;
    for (const candidate of candidates) {
        if (candidate.createdAt >= revertedAt) {
            break;
        }
        paired = candidate;
    }
    return paired;
}

export function matchReverts(
    db: CacheDatabase,
    opts: RevertOptions
): RevertTally {
    const tally: RevertTally = {
        byAuthor: new Map(),
        matched: 0,
        unmatched: 0,
    };
    const reverts = readRevertPullRequests(db, opts);
    if (reverts.length === 0) {
        return tally;
    }

    const titles = [...new Set(reverts.map((revert) => revert.reverted))];
    const candidates = readCandidates(db, opts, titles);

    for (const revert of reverts) {
        const original = pairCandidate(
            candidates.get(candidateKey(revert.repo, revert.reverted)),
            revert.createdAt
        );
        if (original === null) {
            tally.unmatched += 1;
            continue;
        }
        tally.matched += 1;
        if (original.authorId === null || original.author === null) {
            continue;
        }
        if (original.isBot) {
            continue;
        }
        const credited = tally.byAuthor.get(original.authorId);
        tally.byAuthor.set(original.authorId, {
            author: original.author,
            reverted: (credited?.reverted ?? 0) + 1,
        });
    }
    return tally;
}
