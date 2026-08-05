import { and, eq, inArray } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import {
    authorAliases,
    authorGithubLogins,
    authors,
    reviews,
    tickets,
} from "../cache/schema";
import type { SpanicalConfig } from "../config/schema";
import { upsertAuthor, upsertGithubLogin } from "../extract/authors";

const NOREPLY_EMAIL = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/;

export type LoginResolver = {
    resolve: (login: string) => number;
    bridgedLogins: () => Set<string>;
};

// GitHub logins are case-insensitive: the API returns canonical casing while
// noreply addresses and hand-typed config entries routinely differ, so every
// lookup and binding is keyed on the lowercased form.
function loginKey(login: string): string {
    return login.toLowerCase();
}

export function parseNoreplyLogin(email: string): string | null {
    return NOREPLY_EMAIL.exec(email)?.[1] ?? null;
}

function pruneStaleBindings(db: CacheDatabase, bridged: Set<string>): void {
    const bindings = db
        .select({
            login: authorGithubLogins.login,
            canonicalName: authors.canonicalName,
        })
        .from(authorGithubLogins)
        .innerJoin(authors, eq(authors.id, authorGithubLogins.authorId))
        .all();
    // A binding whose author is named after the login is provisional and still
    // carries attribution for cached tickets; only a binding to a real canonical
    // author that config no longer declares is stale.
    const stale = bindings
        .filter(
            (binding) =>
                !bridged.has(loginKey(binding.login)) &&
                loginKey(binding.canonicalName) !== loginKey(binding.login)
        )
        .map((binding) => binding.login);
    if (stale.length > 0) {
        db.delete(authorGithubLogins)
            .where(inArray(authorGithubLogins.login, stale))
            .run();
    }
}

// Config entries are seeded first so a configured mapping always beats the login
// inferred from a users.noreply.github.com address.
export function bridgeGithubLogins(
    db: CacheDatabase,
    config: SpanicalConfig
): LoginResolver {
    const loginToAuthorId = new Map<string, number>();

    for (const [canonicalName, author] of Object.entries(config.authors)) {
        const logins = author.github ?? [];
        if (logins.length === 0) {
            continue;
        }
        const authorId = upsertAuthor(db, canonicalName);
        for (const login of logins) {
            upsertGithubLogin(db, login, authorId);
            loginToAuthorId.set(loginKey(login), authorId);
        }
    }

    const aliases = db
        .select({
            email: authorAliases.email,
            authorId: authorAliases.authorId,
        })
        .from(authorAliases)
        .all();
    for (const alias of aliases) {
        const login = parseNoreplyLogin(alias.email);
        if (login === null || loginToAuthorId.has(loginKey(login))) {
            continue;
        }
        upsertGithubLogin(db, login, alias.authorId);
        loginToAuthorId.set(loginKey(login), alias.authorId);
    }

    const bridged = new Set(loginToAuthorId.keys());
    pruneStaleBindings(db, bridged);

    function resolve(login: string): number {
        const known = loginToAuthorId.get(loginKey(login));
        if (known !== undefined) {
            return known;
        }
        const provisionalId = upsertAuthor(db, login);
        upsertGithubLogin(db, login, provisionalId);
        loginToAuthorId.set(loginKey(login), provisionalId);
        return provisionalId;
    }

    return { resolve, bridgedLogins: () => bridged };
}

// Derived from the cache rather than from what this run happened to touch, so a
// fully cached sync still reports identities the report would otherwise split.
export function findUnmappedLogins(
    db: CacheDatabase,
    repoNames: string[],
    bridged: Set<string>
): string[] {
    if (repoNames.length === 0) {
        return [];
    }
    const inRepos = inArray(tickets.repo, repoNames);
    const authored = db
        .selectDistinct({ login: tickets.author })
        .from(tickets)
        .where(and(inRepos, eq(tickets.authorIsBot, false)))
        .all();
    const assigned = db
        .selectDistinct({ login: tickets.assignee })
        .from(tickets)
        .where(and(inRepos, eq(tickets.assigneeIsBot, false)))
        .all();
    const reviewed = db
        .selectDistinct({ login: reviews.reviewer })
        .from(reviews)
        .innerJoin(tickets, eq(tickets.nodeId, reviews.prNodeId))
        .where(and(inRepos, eq(reviews.reviewerIsBot, false)))
        .all();

    const unmapped = new Map<string, string>();
    for (const row of [...authored, ...assigned, ...reviewed]) {
        if (row.login === null) {
            continue;
        }
        const key = loginKey(row.login);
        if (!bridged.has(key) && !unmapped.has(key)) {
            unmapped.set(key, row.login);
        }
    }
    return [...unmapped.values()].sort();
}

export function formatUnmappedLoginsWarning(logins: string[]): string {
    const entries = logins
        .map(
            (login) =>
                `        "${login}": { emails: ["..."], github: ["${login}"] },`
        )
        .join("\n");
    return [
        `warning: ${logins.length} GitHub login(s) are not mapped to an author and were counted on their own. Merge them in spanical.config.ts:`,
        "    authors: {",
        entries,
        "    },",
    ].join("\n");
}
