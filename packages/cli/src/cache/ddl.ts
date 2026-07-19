// The cache is created without a migration tool, so these DDL strings are a
// second representation of schema.ts's tables. The introspection test in
// cache.test.ts guards the two against drift by comparing PRAGMA table_info
// against the Drizzle column definitions.

export const CREATE_TABLE_STATEMENTS = [
    `CREATE TABLE authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canonical_name TEXT NOT NULL UNIQUE
    );`,
    `CREATE TABLE author_aliases (
        email TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES authors(id)
    );`,
    `CREATE TABLE commits (
        sha TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES authors(id),
        authored_at INTEGER NOT NULL,
        is_merge INTEGER NOT NULL
    );`,
    `CREATE TABLE commit_authors (
        sha TEXT NOT NULL REFERENCES commits(sha),
        author_id INTEGER NOT NULL REFERENCES authors(id),
        weight REAL NOT NULL,
        PRIMARY KEY (sha, author_id)
    );`,
    `CREATE TABLE file_changes (
        sha TEXT NOT NULL REFERENCES commits(sha),
        repo TEXT NOT NULL,
        path TEXT NOT NULL,
        added INTEGER,
        deleted INTEGER,
        is_binary INTEGER NOT NULL,
        is_migration INTEGER NOT NULL,
        PRIMARY KEY (sha, path)
    );`,
    `CREATE TABLE scc_snapshots (
        repo TEXT NOT NULL,
        month TEXT NOT NULL,
        path TEXT NOT NULL,
        language TEXT NOT NULL,
        code INTEGER NOT NULL,
        complexity INTEGER NOT NULL,
        sha TEXT NOT NULL,
        PRIMARY KEY (repo, sha, path)
    );`,
    `CREATE TABLE extractions (
        repo TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        tip_sha TEXT NOT NULL,
        since TEXT,
        extracted_at INTEGER NOT NULL
    );`,
    `CREATE TABLE file_ownership (
        repo TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        path TEXT NOT NULL,
        author_id INTEGER NOT NULL REFERENCES authors(id),
        surviving_lines INTEGER NOT NULL,
        PRIMARY KEY (repo, head_sha, path, author_id)
    );`,
];

const INDEX_DEFINITIONS = [
    { name: "idx_commits_repo", table: "commits", columns: ["repo"] },
    { name: "idx_commits_author_id", table: "commits", columns: ["author_id"] },
    {
        name: "idx_commit_authors_author_id",
        table: "commit_authors",
        columns: ["author_id"],
    },
    {
        name: "idx_commits_authored_at",
        table: "commits",
        columns: ["authored_at"],
    },
    { name: "idx_file_changes_repo", table: "file_changes", columns: ["repo"] },
    { name: "idx_file_changes_path", table: "file_changes", columns: ["path"] },
    {
        name: "idx_scc_snapshots_repo",
        table: "scc_snapshots",
        columns: ["repo"],
    },
    {
        name: "idx_file_ownership_head",
        table: "file_ownership",
        columns: ["repo", "head_sha"],
    },
] as const;

export const CACHE_INDEX_NAMES = INDEX_DEFINITIONS.map(
    (definition) => definition.name
);

export const CREATE_INDEX_STATEMENTS = INDEX_DEFINITIONS.map(
    (definition) =>
        `CREATE INDEX ${definition.name} ON ${definition.table} (${definition.columns.join(", ")});`
);
