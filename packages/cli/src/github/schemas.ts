import { z } from "zod";

// GitHub declares every connection as `nodes: [T]` — a nullable list of nullable
// elements, with nulls returned for nodes the token cannot see. The schemas
// model that shape so a null element fails as missing data rather than as an
// unrecognised response; the accompanying top-level `errors` entry is what the
// client refuses on.
function nullableNodes<Node extends z.ZodType>(node: Node) {
    return z.array(node.nullable()).nullable();
}

const nonNullActorSchema = z.object({
    login: z.string(),
    typename: z.string(),
});

const actorSchema = nonNullActorSchema.nullable();

const rateLimitSchema = z.object({
    cost: z.number(),
    remaining: z.number(),
    resetAt: z.iso.datetime(),
});

const pageInfoSchema = z.object({
    hasNextPage: z.boolean(),
    endCursor: z.string().nullable(),
});

const ticketFieldsSchema = z.object({
    id: z.string(),
    number: z.number().int(),
    title: z.string(),
    state: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().nullable(),
    author: actorSchema,
    assignees: z.object({ nodes: nullableNodes(nonNullActorSchema) }),
    reopened: z.object({ filteredCount: z.number().int() }),
    closed: z.object({
        nodes: nullableNodes(z.object({ actor: actorSchema.optional() })),
    }),
});

const reviewSchema = z.object({
    id: z.string(),
    state: z.string(),
    submittedAt: z.iso.datetime().nullable(),
    author: actorSchema,
});

// requestedReviewer carries no login when a team rather than a user was asked,
// because the query only spreads the User fragment.
const reviewRequestSchema = z.object({
    createdAt: z.iso.datetime(),
    requestedReviewer: z
        .object({ login: z.string().optional() })
        .nullable()
        .optional(),
});

const pullRequestSchema = ticketFieldsSchema.extend({
    mergedAt: z.iso.datetime().nullable(),
    additions: z.number().int(),
    deletions: z.number().int(),
    requests: z.object({
        filteredCount: z.number().int(),
        nodes: nullableNodes(reviewRequestSchema),
    }),
    reviews: z
        .object({
            totalCount: z.number().int(),
            nodes: nullableNodes(reviewSchema),
        })
        .nullable(),
});

export const pullRequestPageSchema = z.object({
    rateLimit: rateLimitSchema.nullable(),
    repository: z.object({
        pullRequests: z.object({
            pageInfo: pageInfoSchema,
            nodes: nullableNodes(pullRequestSchema),
        }),
    }),
});

export const issuePageSchema = z.object({
    rateLimit: rateLimitSchema.nullable(),
    repository: z.object({
        issues: z.object({
            pageInfo: pageInfoSchema,
            nodes: nullableNodes(ticketFieldsSchema),
        }),
    }),
});

export const graphqlEnvelopeSchema = z.object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() })).optional(),
});

export type Actor = z.infer<typeof actorSchema>;
export type RateLimit = z.infer<typeof rateLimitSchema>;
export type PullRequestNode = z.infer<typeof pullRequestSchema>;
export type IssueNode = z.infer<typeof ticketFieldsSchema>;
export type ReviewNode = z.infer<typeof reviewSchema>;

export function compactNodes<Node>(nodes: (Node | null)[] | null): Node[] {
    return (nodes ?? []).filter((node) => node !== null);
}
