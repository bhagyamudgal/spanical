import type { reviews, tickets } from "../cache/schema";
import type { LoginResolver } from "./identity";
import { REVIEW_REQUEST_LIMIT } from "./query";
import {
    compactNodes,
    type Actor,
    type IssueNode,
    type PullRequestNode,
} from "./schemas";

const BOT_TYPENAME = "Bot";

export const TICKET_KIND = { pullRequest: "pr", issue: "issue" } as const;

export type TicketRow = typeof tickets.$inferInsert;
export type ReviewRow = typeof reviews.$inferInsert;

type CreditedActor = { login: string | null; isBot: boolean };

function toNullableInstant(value: string | null): number | null {
    return value === null ? null : Date.parse(value);
}

// Bots keep their raw login and the is_bot flag but are never credited to a
// canonical author, so they cannot pollute the unmapped-login warning.
function creditActor(
    resolver: LoginResolver,
    actor: Actor | undefined
): CreditedActor {
    if (actor === undefined || actor === null) {
        return { login: null, isBot: false };
    }
    const isBot = actor.typename === BOT_TYPENAME;
    if (!isBot) {
        resolver.resolve(actor.login);
    }
    return { login: actor.login, isBot };
}

export function buildTicketRow(
    resolver: LoginResolver,
    repoName: string,
    node: IssueNode,
    kind: string
): TicketRow {
    const author = creditActor(resolver, node.author);
    const assignee = creditActor(
        resolver,
        compactNodes(node.assignees.nodes)[0]
    );
    const closedBy = creditActor(
        resolver,
        compactNodes(node.closed.nodes)[0]?.actor
    );
    return {
        nodeId: node.id,
        repo: repoName,
        kind,
        number: node.number,
        title: node.title,
        author: author.login,
        authorIsBot: author.isBot,
        assignee: assignee.login,
        assigneeIsBot: assignee.isBot,
        closedBy: closedBy.login,
        closedByIsBot: closedBy.isBot,
        createdAt: Date.parse(node.createdAt),
        closedAt: toNullableInstant(node.closedAt),
        mergedAt: null,
        updatedAt: Date.parse(node.updatedAt),
        state: node.state,
        reopenedCount: node.reopened.filteredCount,
        additions: null,
        deletions: null,
    };
}

export function buildPullRequestRow(
    resolver: LoginResolver,
    repoName: string,
    node: PullRequestNode
): TicketRow {
    return {
        ...buildTicketRow(resolver, repoName, node, TICKET_KIND.pullRequest),
        mergedAt: toNullableInstant(node.mergedAt),
        additions: node.additions,
        deletions: node.deletions,
    };
}

function requestTimesByLogin(
    node: PullRequestNode,
    repoName: string
): Map<string, number[]> {
    const requests = compactNodes(node.requests.nodes);
    // Not paginated on purpose: timelineItems returns oldest-first, so the first
    // page already holds the earliest requests the pairing below walks forward
    // through. Past the cap the later re-requests are the ones lost.
    if (node.requests.filteredCount > requests.length) {
        process.stderr.write(
            `warning: ${repoName}#${node.number} has ${node.requests.filteredCount} review request(s) but only the first ${REVIEW_REQUEST_LIMIT} were fetched; reviews paired with a later request fall back to the "created" latency basis.\n`
        );
    }
    const byLogin = new Map<string, number[]>();
    for (const request of requests) {
        const login = request.requestedReviewer?.login;
        if (login === undefined) {
            continue;
        }
        const key = login.toLowerCase();
        const times = byLogin.get(key) ?? [];
        times.push(Date.parse(request.createdAt));
        byLogin.set(key, times);
    }
    for (const times of byLogin.values()) {
        times.sort((left, right) => left - right);
    }
    return byLogin;
}

// A reviewer asked twice must have their second review measured from the second
// request, so each review pairs with the latest request that preceded it.
function pairRequest(
    times: number[] | undefined,
    submittedAt: number | null
): number | null {
    if (times === undefined || submittedAt === null) {
        return null;
    }
    let paired: number | null = null;
    for (const time of times) {
        if (time > submittedAt) {
            break;
        }
        paired = time;
    }
    return paired;
}

export function buildReviewRows(
    resolver: LoginResolver,
    repoName: string,
    node: PullRequestNode
): ReviewRow[] {
    const reviewNodes = compactNodes(node.reviews?.nodes ?? null);
    const totalCount = node.reviews?.totalCount ?? reviewNodes.length;
    // The reviews connection takes no orderBy and returns oldest-first, so a
    // truncated PR loses its most recent reviews — exactly the ones a report
    // window is likely to want — and re-syncing returns the same first page.
    if (totalCount > reviewNodes.length) {
        process.stderr.write(
            `warning: ${repoName}#${node.number} has ${totalCount} review(s) but only the oldest ${reviewNodes.length} were fetched; ${totalCount - reviewNodes.length} more recent review(s) are missing from review metrics.\n`
        );
    }

    const requestTimes = requestTimesByLogin(node, repoName);
    return reviewNodes.map((review) => {
        const reviewer = creditActor(resolver, review.author);
        const submittedAt = toNullableInstant(review.submittedAt);
        return {
            nodeId: review.id,
            prNodeId: node.id,
            reviewer: reviewer.login,
            reviewerIsBot: reviewer.isBot,
            submittedAt,
            requestedAt:
                reviewer.login === null
                    ? null
                    : pairRequest(
                          requestTimes.get(reviewer.login.toLowerCase()),
                          submittedAt
                      ),
            state: review.state,
        };
    });
}
