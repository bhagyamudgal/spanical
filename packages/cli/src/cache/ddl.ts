// The cache is created without a migration tool, so these DDL strings are a
// second representation of schema.ts's tables. The introspection test in
// cache.test.ts guards the two against drift by comparing PRAGMA table_info
// against the Drizzle column definitions.
//
// PRAGMA foreign_keys is never enabled, so every REFERENCES clause below is
// documentation: nothing cascades and nothing is enforced. Code that deletes a
// parent row has to remove its children itself.

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
        is_boundary INTEGER NOT NULL,
        PRIMARY KEY (repo, sha, path)
    );`,
    `CREATE TABLE extractions (
        repo TEXT PRIMARY KEY,
        branch TEXT NOT NULL,
        tip_sha TEXT NOT NULL,
        since TEXT,
        config_key TEXT NOT NULL,
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
    `CREATE TABLE line_deaths (
        repo TEXT NOT NULL,
        sha TEXT NOT NULL REFERENCES commits(sha),
        path TEXT NOT NULL,
        victim_sha TEXT NOT NULL,
        victim_author_id INTEGER NOT NULL REFERENCES authors(id),
        victim_authored_at INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        PRIMARY KEY (repo, sha, path, victim_sha)
    );`,
    `CREATE TABLE rework_captures (
        repo TEXT PRIMARY KEY,
        failed_candidates INTEGER NOT NULL,
        captured_at INTEGER NOT NULL
    );`,
    `CREATE TABLE author_github_logins (
        login TEXT COLLATE NOCASE PRIMARY KEY,
        author_id INTEGER NOT NULL REFERENCES authors(id)
    );`,
    `CREATE TABLE github_syncs (
        repo TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        since TEXT,
        synced_through INTEGER NOT NULL,
        issues_synced_through INTEGER NOT NULL,
        synced_at INTEGER NOT NULL
    );`,
    `CREATE TABLE tickets (
        node_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        author_is_bot INTEGER NOT NULL,
        assignee TEXT,
        assignee_is_bot INTEGER NOT NULL,
        closed_by TEXT,
        closed_by_is_bot INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        merged_at INTEGER,
        updated_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        reopened_count INTEGER NOT NULL,
        additions INTEGER,
        deletions INTEGER
    );`,
    `CREATE TABLE reviews (
        node_id TEXT PRIMARY KEY,
        pr_node_id TEXT NOT NULL REFERENCES tickets(node_id),
        reviewer TEXT,
        reviewer_is_bot INTEGER NOT NULL,
        submitted_at INTEGER,
        requested_at INTEGER,
        state TEXT NOT NULL
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
    // Rework candidate paging orders by (sha, path) within one repo; the
    // matching index turns each keyset page into a seek instead of a scan.
    {
        name: "idx_file_changes_repo_sha_path",
        table: "file_changes",
        columns: ["repo", "sha", "path"],
    },
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
    {
        name: "idx_line_deaths_repo",
        table: "line_deaths",
        columns: ["repo"],
    },
    {
        name: "idx_line_deaths_victim_author",
        table: "line_deaths",
        columns: ["victim_author_id"],
    },
    {
        name: "idx_author_github_logins_author_id",
        table: "author_github_logins",
        columns: ["author_id"],
    },
    {
        name: "idx_reviews_pr_node_id",
        table: "reviews",
        columns: ["pr_node_id"],
    },
] as const;

// (repo, kind, number) is a ticket's natural key. GitHub is migrating to a new
// global-ID format, so a re-issued node_id must collide loudly here instead of
// quietly inserting a duplicate that inflates every count. Its repo prefix also
// serves the repo-scoped lookups, so no separate repo index is needed.
const UNIQUE_INDEX_DEFINITIONS = [
    {
        name: "idx_tickets_repo_kind_number",
        table: "tickets",
        columns: ["repo", "kind", "number"],
    },
] as const;

type IndexDefinition = {
    name: string;
    table: string;
    columns: readonly string[];
};

function createIndexStatement(
    definition: IndexDefinition,
    isUnique: boolean
): string {
    const uniqueKeyword = isUnique ? "UNIQUE " : "";
    return `CREATE ${uniqueKeyword}INDEX ${definition.name} ON ${definition.table} (${definition.columns.join(", ")});`;
}

export const CACHE_INDEX_NAMES = [
    ...INDEX_DEFINITIONS,
    ...UNIQUE_INDEX_DEFINITIONS,
].map((definition) => definition.name);

export const CREATE_INDEX_STATEMENTS = [
    ...INDEX_DEFINITIONS.map((definition) =>
        createIndexStatement(definition, false)
    ),
    ...UNIQUE_INDEX_DEFINITIONS.map((definition) =>
        createIndexStatement(definition, true)
    ),
];
