// Pull requests page at half the issue rate: measured against a large public
// repository, 100 pull requests each carrying 100 reviews and 50 timeline items
// takes ~9s and intermittently trips GitHub's request timeout, while 50 returns
// in ~4s. Cost is not the constraint here — a full page scores under 5 points.
export const PULL_REQUEST_PAGE_SIZE = 50;
export const ISSUE_PAGE_SIZE = 100;
export const REVIEW_PAGE_SIZE = 100;
export const REVIEW_REQUEST_LIMIT = 50;

// filteredCount, never totalCount: on PullRequest.timelineItems totalCount ignores
// itemTypes and returns the whole timeline length, which reads as a plausible
// reopen count rather than an obvious error.
const TICKET_FIELDS = `
                id
                number
                title
                state
                createdAt
                updatedAt
                closedAt
                author { login typename: __typename }
                assignees(first: 1) { nodes { login typename: __typename } }
                reopened: timelineItems(itemTypes: [REOPENED_EVENT], first: 1) {
                    filteredCount
                }
                closed: timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
                    nodes {
                        ... on ClosedEvent {
                            actor { login typename: __typename }
                        }
                    }
                }`;

export const PULL_REQUESTS_QUERY = `query PullRequests($owner: String!, $name: String!, $cursor: String) {
    rateLimit {
        cost
        remaining
        resetAt
    }
    repository(owner: $owner, name: $name) {
        pullRequests(first: ${PULL_REQUEST_PAGE_SIZE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo {
                hasNextPage
                endCursor
            }
            nodes {${TICKET_FIELDS}
                mergedAt
                additions
                deletions
                requests: timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: ${REVIEW_REQUEST_LIMIT}) {
                    filteredCount
                    nodes {
                        ... on ReviewRequestedEvent {
                            createdAt
                            requestedReviewer {
                                ... on User { login }
                            }
                        }
                    }
                }
                reviews(first: ${REVIEW_PAGE_SIZE}) {
                    totalCount
                    nodes {
                        id
                        state
                        submittedAt
                        author { login typename: __typename }
                    }
                }
            }
        }
    }
}`;

export const ISSUES_QUERY = `query Issues($owner: String!, $name: String!, $cursor: String) {
    rateLimit {
        cost
        remaining
        resetAt
    }
    repository(owner: $owner, name: $name) {
        issues(first: ${ISSUE_PAGE_SIZE}, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo {
                hasNextPage
                endCursor
            }
            nodes {${TICKET_FIELDS}
            }
        }
    }
}`;
