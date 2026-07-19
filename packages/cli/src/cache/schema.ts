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

export const cacheSchema = {
    authors,
    authorAliases,
    commits,
    commitAuthors,
    fileChanges,
    sccSnapshots,
    extractions,
    fileOwnership,
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
];

export const CACHE_TABLE_NAMES = cacheTables.map((table) =>
    getTableName(table)
);
