import { getTableName } from "drizzle-orm";
import {
    integer,
    primaryKey,
    real,
    sqliteTable,
    text,
    type SQLiteTable,
} from "drizzle-orm/sqlite-core";

export const authors = sqliteTable("authors", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonicalName: text("canonical_name").notNull().unique(),
});

export const authorAliases = sqliteTable("author_aliases", {
    email: text("email").primaryKey(),
    name: text("name").notNull(),
    authorId: integer("author_id")
        .notNull()
        .references(() => authors.id),
});

export const commits = sqliteTable("commits", {
    sha: text("sha").primaryKey(),
    repo: text("repo").notNull(),
    authorId: integer("author_id")
        .notNull()
        .references(() => authors.id),
    authoredAt: integer("authored_at").notNull(),
    isMerge: integer("is_merge", { mode: "boolean" }).notNull(),
});

export const commitAuthors = sqliteTable(
    "commit_authors",
    {
        sha: text("sha")
            .notNull()
            .references(() => commits.sha),
        authorId: integer("author_id")
            .notNull()
            .references(() => authors.id),
        weight: real("weight").notNull(),
    },
    (table) => [primaryKey({ columns: [table.sha, table.authorId] })]
);

export const fileChanges = sqliteTable(
    "file_changes",
    {
        sha: text("sha")
            .notNull()
            .references(() => commits.sha),
        repo: text("repo").notNull(),
        path: text("path").notNull(),
        added: integer("added"),
        deleted: integer("deleted"),
        isBinary: integer("is_binary", { mode: "boolean" }).notNull(),
        isMigration: integer("is_migration", { mode: "boolean" }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.sha, table.path] })]
);

export const sccSnapshots = sqliteTable(
    "scc_snapshots",
    {
        repo: text("repo").notNull(),
        month: text("month").notNull(),
        path: text("path").notNull(),
        language: text("language").notNull(),
        code: integer("code").notNull(),
        complexity: integer("complexity").notNull(),
        sha: text("sha").notNull(),
        isBoundary: integer("is_boundary", { mode: "boolean" }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.repo, table.sha, table.path] })]
);

export const extractions = sqliteTable("extractions", {
    repo: text("repo").primaryKey(),
    branch: text("branch").notNull(),
    tipSha: text("tip_sha").notNull(),
    since: text("since"),
    configKey: text("config_key").notNull(),
    extractedAt: integer("extracted_at").notNull(),
});

export const fileOwnership = sqliteTable(
    "file_ownership",
    {
        repo: text("repo").notNull(),
        headSha: text("head_sha").notNull(),
        path: text("path").notNull(),
        authorId: integer("author_id")
            .notNull()
            .references(() => authors.id),
        survivingLines: integer("surviving_lines").notNull(),
    },
    (table) => [
        primaryKey({
            columns: [table.repo, table.headSha, table.path, table.authorId],
        }),
    ]
);

// login carries COLLATE NOCASE in ddl.ts, which Drizzle cannot express: GitHub
// logins are case-insensitive, so the read-time join must be too.
export const authorGithubLogins = sqliteTable("author_github_logins", {
    login: text("login").primaryKey(),
    authorId: integer("author_id")
        .notNull()
        .references(() => authors.id),
});

// Issues carry their own watermark so turning includeIssues on backfills them
// without forcing a pull-request re-backfill that has already been paid for.
export const githubSyncs = sqliteTable("github_syncs", {
    repo: text("repo").primaryKey(),
    slug: text("slug").notNull(),
    since: text("since"),
    syncedThrough: integer("synced_through").notNull(),
    issuesSyncedThrough: integer("issues_synced_through").notNull(),
    syncedAt: integer("synced_at").notNull(),
});

// Actors are stored as raw GitHub logins and resolved to a canonical author
// through author_github_logins at query time, so re-mapping an identity never
// costs an API call. See docs/adr/0001.
export const tickets = sqliteTable("tickets", {
    nodeId: text("node_id").primaryKey(),
    repo: text("repo").notNull(),
    kind: text("kind").notNull(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    authorIsBot: integer("author_is_bot", { mode: "boolean" }).notNull(),
    assignee: text("assignee"),
    assigneeIsBot: integer("assignee_is_bot", { mode: "boolean" }).notNull(),
    closedBy: text("closed_by"),
    closedByIsBot: integer("closed_by_is_bot", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
    closedAt: integer("closed_at"),
    mergedAt: integer("merged_at"),
    updatedAt: integer("updated_at").notNull(),
    state: text("state").notNull(),
    reopenedCount: integer("reopened_count").notNull(),
    additions: integer("additions"),
    deletions: integer("deletions"),
});

// requested_at is null when no review-request event exists, which is what the
// "created" latency basis is derived from; it is never stored as its own column.
export const reviews = sqliteTable("reviews", {
    nodeId: text("node_id").primaryKey(),
    prNodeId: text("pr_node_id")
        .notNull()
        .references(() => tickets.nodeId),
    reviewer: text("reviewer"),
    reviewerIsBot: integer("reviewer_is_bot", { mode: "boolean" }).notNull(),
    submittedAt: integer("submitted_at"),
    requestedAt: integer("requested_at"),
    state: text("state").notNull(),
});

export const cacheSchema = {
    authors,
    authorAliases,
    commits,
    commitAuthors,
    fileChanges,
    sccSnapshots,
    extractions,
    fileOwnership,
    authorGithubLogins,
    githubSyncs,
    tickets,
    reviews,
};

export const cacheTables: SQLiteTable[] = [
    authors,
    authorAliases,
    commits,
    commitAuthors,
    fileChanges,
    sccSnapshots,
    extractions,
    fileOwnership,
    authorGithubLogins,
    githubSyncs,
    tickets,
    reviews,
];

export const CACHE_TABLE_NAMES = cacheTables.map((table) =>
    getTableName(table)
);
