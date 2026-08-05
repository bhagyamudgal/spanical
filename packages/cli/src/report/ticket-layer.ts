import { count, inArray } from "drizzle-orm";
import { tryCatch } from "@spanical/utils";
import { aggregateReviews, aggregateTickets } from "../aggregate";
import type {
    ReviewAggregation,
    TicketAggregation,
    TicketAttribution,
} from "../aggregate/types";
import type { CacheDatabase } from "../cache/open";
import { tickets } from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import {
    findGithubToken,
    formatUnmappedLoginsWarning,
    GitHubError,
    syncTickets,
} from "../github";
import {
    renderReviewsReport,
    renderTicketsReport,
    type MarkdownLayout,
} from "../render";

const SECTION_GAP = "\n\n";
const TICKETS_HEADING = "Tickets";
const REVIEWS_HEADING = "Reviews";
// A table title inside a section is one level below the section's own heading.
const TABLE_TITLE_DEPTH = 1;

// hasCachedTickets is scoped to the repos this insight covers, so a section can
// say whether it has anything to fall back on rather than inheriting a verdict
// from repos it does not report.
export type TicketInsight = {
    tickets: TicketAggregation;
    reviews: ReviewAggregation;
    hasCachedTickets: boolean;
};

export type TicketRefreshFailure = { reason: string };

export type TicketRefresh = {
    attribution: TicketAttribution;
    includeIssues: boolean;
    failure: TicketRefreshFailure | null;
};

function countCachedTickets(db: CacheDatabase, repos: string[]): number {
    return (
        db
            .select({ value: count() })
            .from(tickets)
            .where(inArray(tickets.repo, repos))
            .get()?.value ?? 0
    );
}

// A sync that dies on its third repository leaves the first two fresh and the
// rest untouched, and the report cannot tell which section is which, so the
// wording claims only what is true of every one of them: the refresh stopped
// short, and the numbers are the cache rather than a completed sync.
function formatTicketRefreshFailure(
    failure: TicketRefreshFailure,
    hasCachedTickets: boolean
): string {
    const outcome = hasCachedTickets
        ? "the GitHub refresh did not finish, so the ticket data here may be missing anything that changed since the last complete sync"
        : "the GitHub refresh did not finish and nothing is cached here to fall back on, so the ticket layer has nothing to report";
    return `${outcome}. Reason: ${failure.reason}`;
}

// The report degrades where the tickets and reviews subcommands abort: a failed
// refresh is the whole answer there, but here it is a footnote to eight offline
// sections, and spec §5 makes the offline guarantee explicit. Only GitHubError
// is disclosed this way — a cache write that fails on a full disk is not "the
// ticket layer is unavailable", and reporting numbers off a half-written cache
// would be worse than stopping.
export async function refreshTicketCache(
    db: CacheDatabase,
    run: ResolvedRun,
    options: { now: Date }
): Promise<TicketRefresh | null> {
    const ticketsConfig = run.config.tickets;
    const token = findGithubToken();
    if (ticketsConfig === undefined || token === null) {
        return null;
    }
    const layer = {
        attribution: ticketsConfig.attribution,
        includeIssues: ticketsConfig.github.includeIssues,
    };

    const { data: sync, error } = await tryCatch(
        syncTickets(db, run.config, {
            token,
            now: options.now,
            isCacheEnabled: run.cache,
        })
    );
    if (error) {
        if (!(error instanceof GitHubError)) {
            throw error;
        }
        process.stderr.write(
            `warning: the GitHub refresh did not finish; the report's ticket sections read the cache instead. Reason: ${error.message}\n`
        );
        return { ...layer, failure: { reason: error.message } };
    }

    if (sync.unmappedLogins.length > 0) {
        process.stderr.write(
            `${formatUnmappedLoginsWarning(sync.unmappedLogins)}\n`
        );
    }
    return { ...layer, failure: null };
}

export function collectTicketInsight(
    db: CacheDatabase,
    run: ResolvedRun,
    refresh: TicketRefresh,
    repos: string[]
): TicketInsight {
    return {
        tickets: aggregateTickets(db, {
            window: run.window,
            repos,
            attribution: refresh.attribution,
            timezone: run.tz,
            includeIssues: refresh.includeIssues,
        }),
        reviews: aggregateReviews(db, {
            window: run.window,
            repos,
            timezone: run.tz,
        }),
        hasCachedTickets: countCachedTickets(db, repos) > 0,
    };
}

// The warning repeats on every section it applies to: a reader who opens the
// per-repo appendix alone must not read stale counts as fresh ones.
export function ticketSections(input: {
    insight: TicketInsight;
    failure: TicketRefreshFailure | null;
    window: string;
    repos: string[];
    level: number;
}): string[] {
    const heading = "#".repeat(input.level);
    const layout: MarkdownLayout = {
        titleLevel: input.level + TABLE_TITLE_DEPTH,
    };
    const context = { window: input.window, repos: input.repos };
    const warning =
        input.failure === null
            ? []
            : [
                  `Warning: ${formatTicketRefreshFailure(
                      input.failure,
                      input.insight.hasCachedTickets
                  )}`,
              ];

    return [
        [
            `${heading} ${TICKETS_HEADING}`,
            ...warning,
            renderTicketsReport("md", input.insight.tickets, context, layout),
        ].join(SECTION_GAP),
        [
            `${heading} ${REVIEWS_HEADING}`,
            ...warning,
            renderReviewsReport("md", input.insight.reviews, context, layout),
        ].join(SECTION_GAP),
    ];
}
