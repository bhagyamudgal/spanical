import { eq } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { authorAliases, authorGithubLogins, authors } from "../cache/schema";
import type { SpanicalConfig } from "../config/schema";

export type AuthorResolver = {
    resolve: (email: string, name: string) => number;
    unknownEmails: () => string[];
};

export function upsertAuthor(db: CacheDatabase, canonicalName: string): number {
    const inserted = db
        .insert(authors)
        .values({ canonicalName })
        .onConflictDoNothing()
        .returning({ id: authors.id })
        .get();
    if (inserted) {
        return inserted.id;
    }
    const existing = db
        .select({ id: authors.id })
        .from(authors)
        .where(eq(authors.canonicalName, canonicalName))
        .get();
    if (!existing) {
        throw new Error(`Failed to resolve author id for "${canonicalName}".`);
    }
    return existing.id;
}

function upsertAlias(
    db: CacheDatabase,
    email: string,
    name: string,
    authorId: number
): void {
    db.insert(authorAliases)
        .values({ email, name, authorId })
        .onConflictDoUpdate({
            target: authorAliases.email,
            set: { name, authorId },
        })
        .run();
}

export function upsertGithubLogin(
    db: CacheDatabase,
    login: string,
    authorId: number
): void {
    db.insert(authorGithubLogins)
        .values({ login, authorId })
        .onConflictDoUpdate({
            target: authorGithubLogins.login,
            set: { authorId },
        })
        .run();
}

export function seedAndResolveAuthors(
    db: CacheDatabase,
    config: SpanicalConfig
): AuthorResolver {
    const emailToAuthorId = new Map<string, number>();
    const unknownEmails = new Set<string>();

    // GitHub logins are seeded on every run, not only when the ticket layer
    // syncs, so editing config.authors re-maps already-cached tickets offline.
    for (const [canonicalName, author] of Object.entries(config.authors)) {
        const authorId = upsertAuthor(db, canonicalName);
        for (const email of author.emails) {
            upsertAlias(db, email, canonicalName, authorId);
            emailToAuthorId.set(email, authorId);
        }
        for (const login of author.github ?? []) {
            upsertGithubLogin(db, login, authorId);
        }
    }

    function resolve(email: string, name: string): number {
        const known = emailToAuthorId.get(email);
        if (known !== undefined) {
            return known;
        }
        const provisionalId = upsertAuthor(db, email);
        upsertAlias(db, email, name, provisionalId);
        emailToAuthorId.set(email, provisionalId);
        unknownEmails.add(email);
        return provisionalId;
    }

    return {
        resolve,
        unknownEmails: () => [...unknownEmails],
    };
}
