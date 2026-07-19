import { eq, inArray } from "drizzle-orm";
import { tryCatch } from "@spanical/utils";
import { openCache, type CacheDatabase } from "../cache/open";
import {
    commitAuthors,
    commits,
    extractions,
    fileChanges,
} from "../cache/schema";
import { loadConfig } from "../config/load";
import type { SpanicalConfig } from "../config/schema";
import { seedAndResolveAuthors, type AuthorResolver } from "./authors";
import {
    assertGitAvailable,
    getBranchTipSha,
    resolveDefaultBranch,
    streamGitLog,
} from "./git";

type RepoConfig = SpanicalConfig["repos"][number];

export type RepoExtraction = {
    repo: string;
    status: "extracted" | "skipped";
    commitCount: number;
    fileChangeCount: number;
};

export type ExtractionResult = {
    repos: RepoExtraction[];
    unknownEmails: string[];
};

function dedupeIds(ids: number[]): number[] {
    return [...new Set(ids)];
}

function deleteRepoRows(db: CacheDatabase, repo: string): void {
    db.delete(commitAuthors)
        .where(
            inArray(
                commitAuthors.sha,
                db
                    .select({ sha: commits.sha })
                    .from(commits)
                    .where(eq(commits.repo, repo))
            )
        )
        .run();
    db.delete(fileChanges).where(eq(fileChanges.repo, repo)).run();
    db.delete(commits).where(eq(commits.repo, repo)).run();
}

export async function extractRepo(
    db: CacheDatabase,
    resolver: AuthorResolver,
    repo: RepoConfig,
    config: SpanicalConfig,
    opts: { noCache: boolean; now: Date }
): Promise<RepoExtraction> {
    const branch = await resolveDefaultBranch(repo.path, repo.branch);
    const tip = await getBranchTipSha(repo.path, branch);
    const since = config.since ?? null;

    if (!opts.noCache) {
        const existing = db
            .select({ tipSha: extractions.tipSha, since: extractions.since })
            .from(extractions)
            .where(eq(extractions.repo, repo.name))
            .get();
        if (existing && existing.tipSha === tip && existing.since === since) {
            return {
                repo: repo.name,
                status: "skipped",
                commitCount: 0,
                fileChangeCount: 0,
            };
        }
    }

    deleteRepoRows(db, repo.name);

    const excludeMatchers = config.exclude.map(
        (pattern) => new Bun.Glob(pattern)
    );
    const migrationMatcher = new Bun.Glob(config.migrationsPath);

    let commitCount = 0;
    let fileChangeCount = 0;

    for await (const commit of streamGitLog(repo.path, branch, config.since)) {
        const authorId = resolver.resolve(
            commit.authorEmail,
            commit.authorName
        );
        const creditedIds = dedupeIds([
            authorId,
            ...commit.coAuthors.map((coAuthor) =>
                resolver.resolve(coAuthor.email, coAuthor.name)
            ),
        ]);
        const weight = 1 / creditedIds.length;
        const includedFiles = commit.files.filter(
            (file) => !excludeMatchers.some((glob) => glob.match(file.path))
        );

        db.transaction((tx) => {
            tx.insert(commits)
                .values({
                    sha: commit.sha,
                    repo: repo.name,
                    authorId,
                    authoredAt: commit.authoredAt,
                    isMerge: false,
                })
                .run();
            tx.insert(commitAuthors)
                .values(
                    creditedIds.map((id) => ({
                        sha: commit.sha,
                        authorId: id,
                        weight,
                    }))
                )
                .run();
            if (includedFiles.length > 0) {
                tx.insert(fileChanges)
                    .values(
                        includedFiles.map((file) => ({
                            sha: commit.sha,
                            repo: repo.name,
                            path: file.path,
                            added: file.added,
                            deleted: file.deleted,
                            isBinary: file.isBinary,
                            isMigration: migrationMatcher.match(file.path),
                        }))
                    )
                    .run();
            }
        });

        commitCount += 1;
        fileChangeCount += includedFiles.length;
    }

    const extractedAt = opts.now.getTime();
    db.insert(extractions)
        .values({ repo: repo.name, branch, tipSha: tip, since, extractedAt })
        .onConflictDoUpdate({
            target: extractions.repo,
            set: { branch, tipSha: tip, since, extractedAt },
        })
        .run();

    return {
        repo: repo.name,
        status: "extracted",
        commitCount,
        fileChangeCount,
    };
}

async function runExtraction(
    db: CacheDatabase,
    config: SpanicalConfig,
    noCache: boolean,
    now: Date
): Promise<ExtractionResult> {
    const resolver = seedAndResolveAuthors(db, config);
    const repos: RepoExtraction[] = [];
    for (const repo of config.repos) {
        repos.push(
            await extractRepo(db, resolver, repo, config, { noCache, now })
        );
    }
    return { repos, unknownEmails: resolver.unknownEmails() };
}

export async function extractAll(options: {
    configPath?: string;
    cwd?: string;
    noCache?: boolean;
    now: Date;
}): Promise<ExtractionResult> {
    assertGitAvailable();
    const config = await loadConfig({
        configPath: options.configPath,
        cwd: options.cwd,
    });
    const handle = openCache({
        configPath: options.configPath,
        cwd: options.cwd,
    });
    const result = await tryCatch(
        runExtraction(handle.db, config, options.noCache ?? false, options.now)
    );
    handle.sqlite.close();
    if (result.error) {
        throw result.error;
    }
    return result.data;
}
