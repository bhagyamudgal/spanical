import { and, count, eq, inArray } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { githubSyncs, reviews, tickets } from "../cache/schema";
import type { SpanicalConfig } from "../config/schema";
import { zonedStartOfDay } from "../window";
import {
    applyRateLimitBackoff,
    runGraphQLQuery,
    type GraphQLTransport,
} from "./client";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";
import {
    bridgeGithubLogins,
    findUnmappedLogins,
    type LoginResolver,
} from "./identity";
import { ISSUES_QUERY, PULL_REQUESTS_QUERY } from "./query";
import {
    buildPullRequestRow,
    buildReviewRows,
    buildTicketRow,
    TICKET_KIND,
    type ReviewRow,
    type TicketRow,
} from "./rows";
import {
    compactNodes,
    issuePageSchema,
    pullRequestPageSchema,
    type IssueNode,
    type PullRequestNode,
    type RateLimit,
} from "./schemas";
import { formatSlug, resolveRepoSlug, type RepoSlug } from "./slug";

const UNBOUNDED_SINCE = 0;
// The watermark is a local clock reading compared against GitHub's timestamps.
// An hour of overlap absorbs clock skew and the reordering of a DESC-sorted
// connection that mutates while it is being walked; upserts make it free.
const WATERMARK_SAFETY_MS = 60 * 60 * 1000;

type RepoRef = SpanicalConfig["repos"][number];
type TicketsConfig = NonNullable<SpanicalConfig["tickets"]>;

type SyncCursor = {
    slug: string;
    since: string | null;
    syncedThrough: number;
    issuesSyncedThrough: number;
};

type FetchFloors = {
    pullRequests: number;
    issues: number;
    isRepointed: boolean;
};

type Page<Node> = {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: (Node | null)[] | null;
};

type RepoSyncOptions = {
    token: string;
    transport: GraphQLTransport;
    includeIssues: boolean;
    isCacheEnabled: boolean;
    since: string | null;
    timezone: string;
    now: Date;
};

export type RepoSync = {
    repo: string;
    slug: string;
    ticketCount: number;
    reviewCount: number;
};

export type TicketSync = {
    repos: RepoSync[];
    unmappedLogins: string[];
};

// The rest of the tool computes period boundaries as TZDate in the configured
// zone, so the ticket floor has to start from the same instant as the window.
function toInstant(since: string | null, timezone: string): number {
    return since === null
        ? UNBOUNDED_SINCE
        : zonedStartOfDay(since, timezone).getTime();
}

// Mirrors extractRepo's cache rule. Pull requests and issues carry separate
// watermarks so turning includeIssues on backfills issues without re-fetching
// pull requests, and a repointed slug invalidates both.
export function resolveFetchFloors(
    cursor: SyncCursor | null,
    slug: string,
    options: { since: string | null; timezone: string }
): FetchFloors {
    const sinceFloor = toInstant(options.since, options.timezone);
    if (cursor === null) {
        return {
            pullRequests: sinceFloor,
            issues: sinceFloor,
            isRepointed: false,
        };
    }
    if (cursor.slug !== slug) {
        return {
            pullRequests: sinceFloor,
            issues: sinceFloor,
            isRepointed: true,
        };
    }
    if (sinceFloor < toInstant(cursor.since, options.timezone)) {
        return {
            pullRequests: sinceFloor,
            issues: sinceFloor,
            isRepointed: false,
        };
    }
    return {
        pullRequests: cursor.syncedThrough,
        issues: cursor.issuesSyncedThrough,
        isRepointed: false,
    };
}

// PRAGMA foreign_keys is never enabled, so reviews.pr_node_id does not cascade
// and the review rows have to be removed explicitly or they outlive their PRs.
function purgeRepoTickets(db: CacheDatabase, repoName: string): void {
    db.transaction((tx) => {
        tx.delete(reviews)
            .where(
                inArray(
                    reviews.prNodeId,
                    tx
                        .select({ nodeId: tickets.nodeId })
                        .from(tickets)
                        .where(eq(tickets.repo, repoName))
                )
            )
            .run();
        tx.delete(tickets).where(eq(tickets.repo, repoName)).run();
    });
}

// Issues are only ever refreshed while includeIssues is on, so rows left behind
// by switching it off would be counted by every later report without ever being
// updated again.
function purgeRepoIssues(db: CacheDatabase, repoName: string): number {
    const scope = and(
        eq(tickets.repo, repoName),
        eq(tickets.kind, TICKET_KIND.issue)
    );
    const cached =
        db.select({ value: count() }).from(tickets).where(scope).get()?.value ??
        0;
    if (cached > 0) {
        db.delete(tickets).where(scope).run();
    }
    return cached;
}

function writePage(
    db: CacheDatabase,
    ticketRows: TicketRow[],
    reviewRows: ReviewRow[]
): void {
    if (ticketRows.length === 0) {
        return;
    }
    db.transaction((tx) => {
        for (const row of ticketRows) {
            tx.insert(tickets)
                .values(row)
                .onConflictDoUpdate({ target: tickets.nodeId, set: row })
                .run();
        }
        for (const row of reviewRows) {
            tx.insert(reviews)
                .values(row)
                .onConflictDoUpdate({ target: reviews.nodeId, set: row })
                .run();
        }
    });
}

async function paginate<Node extends { updatedAt: string }>(
    floor: number,
    fetchPage: (
        cursor: string | null
    ) => Promise<{ page: Page<Node>; rateLimit: RateLimit | null }>,
    consume: (nodes: Node[]) => void
): Promise<number> {
    let cursor: string | null = null;
    let consumed = 0;
    for (;;) {
        const { page, rateLimit } = await fetchPage(cursor);
        const nodes = compactNodes(page.nodes);
        // Nodes arrive newest-updated first, so the first node older than the
        // floor ends the walk for this repository.
        const fresh = nodes.filter(
            (node) => Date.parse(node.updatedAt) >= floor
        );
        consume(fresh);
        consumed += fresh.length;
        await applyRateLimitBackoff(rateLimit);
        const { hasNextPage, endCursor } = page.pageInfo;
        if (fresh.length < nodes.length || !hasNextPage || endCursor === null) {
            return consumed;
        }
        cursor = endCursor;
    }
}

async function syncPullRequests(
    db: CacheDatabase,
    resolver: LoginResolver,
    repoName: string,
    slug: RepoSlug,
    floor: number,
    options: RepoSyncOptions
): Promise<{ ticketCount: number; reviewCount: number }> {
    let reviewCount = 0;
    const ticketCount = await paginate<PullRequestNode>(
        floor,
        async (cursor) => {
            const response = await runGraphQLQuery({
                query: PULL_REQUESTS_QUERY,
                queryName: "pullRequests",
                variables: { owner: slug.owner, name: slug.name, cursor },
                schema: pullRequestPageSchema,
                token: options.token,
                transport: options.transport,
            });
            return {
                page: response.repository.pullRequests,
                rateLimit: response.rateLimit,
            };
        },
        (nodes) => {
            const reviewRows = nodes.flatMap((node) =>
                buildReviewRows(resolver, repoName, node)
            );
            reviewCount += reviewRows.length;
            writePage(
                db,
                nodes.map((node) =>
                    buildPullRequestRow(resolver, repoName, node)
                ),
                reviewRows
            );
        }
    );
    return { ticketCount, reviewCount };
}

async function syncIssues(
    db: CacheDatabase,
    resolver: LoginResolver,
    repoName: string,
    slug: RepoSlug,
    floor: number,
    options: RepoSyncOptions
): Promise<number> {
    return paginate<IssueNode>(
        floor,
        async (cursor) => {
            const response = await runGraphQLQuery({
                query: ISSUES_QUERY,
                queryName: "issues",
                variables: { owner: slug.owner, name: slug.name, cursor },
                schema: issuePageSchema,
                token: options.token,
                transport: options.transport,
            });
            return {
                page: response.repository.issues,
                rateLimit: response.rateLimit,
            };
        },
        (nodes) => {
            writePage(
                db,
                nodes.map((node) =>
                    buildTicketRow(resolver, repoName, node, TICKET_KIND.issue)
                ),
                []
            );
        }
    );
}

function readSyncCursor(
    db: CacheDatabase,
    repoName: string
): SyncCursor | null {
    return (
        db
            .select({
                slug: githubSyncs.slug,
                since: githubSyncs.since,
                syncedThrough: githubSyncs.syncedThrough,
                issuesSyncedThrough: githubSyncs.issuesSyncedThrough,
            })
            .from(githubSyncs)
            .where(eq(githubSyncs.repo, repoName))
            .get() ?? null
    );
}

export async function syncRepoTickets(
    db: CacheDatabase,
    resolver: LoginResolver,
    repo: RepoRef,
    slug: RepoSlug,
    options: RepoSyncOptions
): Promise<RepoSync> {
    const formattedSlug = formatSlug(slug);
    // --no-cache drops the watermark so the walk restarts from the since bound;
    // the upserts make re-writing pages that were already cached idempotent.
    const cursor = options.isCacheEnabled
        ? readSyncCursor(db, repo.name)
        : null;
    const floors = resolveFetchFloors(cursor, formattedSlug, options);
    if (floors.isRepointed) {
        process.stderr.write(
            `note: ${repo.name} now points at ${formattedSlug}; dropping its cached tickets and re-syncing from scratch.\n`
        );
        purgeRepoTickets(db, repo.name);
    }
    if (!options.includeIssues) {
        const dropped = purgeRepoIssues(db, repo.name);
        if (dropped > 0) {
            process.stderr.write(
                `note: ${repo.name} no longer syncs issues; dropping ${dropped} cached issue row(s) so they stop counting.\n`
            );
        }
    }

    const syncedAt = options.now.getTime();
    const watermark = syncedAt - WATERMARK_SAFETY_MS;

    const pullRequests = await syncPullRequests(
        db,
        resolver,
        repo.name,
        slug,
        floors.pullRequests,
        options
    );
    const issueCount = options.includeIssues
        ? await syncIssues(
              db,
              resolver,
              repo.name,
              slug,
              floors.issues,
              options
          )
        : 0;

    const row = {
        repo: repo.name,
        slug: formattedSlug,
        since: options.since,
        syncedThrough: watermark,
        // With issues off there are no issue rows left to resume from, so the
        // watermark returns to the since bound and re-enabling backfills.
        issuesSyncedThrough: options.includeIssues
            ? watermark
            : toInstant(options.since, options.timezone),
        syncedAt,
    };
    db.insert(githubSyncs)
        .values(row)
        .onConflictDoUpdate({ target: githubSyncs.repo, set: row })
        .run();

    return {
        repo: repo.name,
        slug: formattedSlug,
        ticketCount: pullRequests.ticketCount + issueCount,
        reviewCount: pullRequests.reviewCount,
    };
}

export function requireTicketsConfig(config: SpanicalConfig): TicketsConfig {
    if (config.tickets === undefined) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.TICKETS_NOT_CONFIGURED,
            'No tickets section in spanical.config.ts, so the GitHub layer was never asked for. Add tickets: { source: "github", github: { token: "env:GITHUB_TOKEN" } } to enable it.'
        );
    }
    return config.tickets;
}

export async function syncTickets(
    db: CacheDatabase,
    config: SpanicalConfig,
    options: {
        token: string;
        now: Date;
        transport?: GraphQLTransport;
        isCacheEnabled?: boolean;
    }
): Promise<TicketSync> {
    const ticketsConfig = requireTicketsConfig(config);

    // Every slug resolves before the first request, so a repo with no origin
    // fails in the first second instead of after paying for its predecessors.
    const slugs = await Promise.all(
        config.repos.map((repo) => resolveRepoSlug(repo))
    );

    const resolver = bridgeGithubLogins(db, config);
    const repoOptions: RepoSyncOptions = {
        token: options.token,
        now: options.now,
        transport: options.transport ?? fetch,
        includeIssues: ticketsConfig.github.includeIssues,
        isCacheEnabled: options.isCacheEnabled ?? true,
        since: config.since ?? null,
        timezone: config.timezone,
    };

    // Repositories sync one at a time because the GraphQL point budget is per
    // token, not per repository.
    const repos: RepoSync[] = [];
    for (const [index, repo] of config.repos.entries()) {
        const slug = slugs[index];
        if (slug === undefined) {
            throw new GitHubError(
                GITHUB_ERROR_CODES.SLUG_INVALID,
                `Repo "${repo.name}" resolved to no GitHub slug.`
            );
        }
        repos.push(
            await syncRepoTickets(db, resolver, repo, slug, repoOptions)
        );
    }

    return {
        repos,
        unmappedLogins: findUnmappedLogins(
            db,
            config.repos.map((repo) => repo.name),
            resolver.bridgedLogins()
        ),
    };
}
