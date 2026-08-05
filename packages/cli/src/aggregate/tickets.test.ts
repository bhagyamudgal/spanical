import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache/open";
import { githubSyncs, tickets } from "../cache/schema";
import { upsertAuthor, upsertGithubLogin } from "../extract/authors";
import { TICKET_KIND, type TicketRow } from "../github/rows";
import {
    renderTicketsReport,
    type MarkdownLayout,
    type RenderFormat,
} from "../render";
import type { ResolvedWindow } from "../window/types";
import { aggregateTickets } from "./tickets";
import type {
    DevTicketRollup,
    TicketAggregation,
    TicketAttribution,
} from "./types";

type Handle = ReturnType<typeof openCache>;
type Actor = { login: string; isBot?: boolean } | null;

const REPO = "web-app";
const WINDOW_START = new Date("2026-07-01T00:00:00Z");
const WINDOW_END = new Date("2026-08-01T00:00:00Z");
const WINDOW: ResolvedWindow = {
    start: WINDOW_START,
    end: WINDOW_END,
    granularity: "month",
    periods: [{ label: "2026-07", start: WINDOW_START, end: WINDOW_END }],
    label: "2026-07",
};

const DEV_ONE = { login: "dev-one-gh" };
const DEV_TWO = { login: "dev-two-gh" };
const DEV_THREE = { login: "dev-three-gh" };
const BOT = { login: "renovate", isBot: true };

const CHECKOUT_TITLE = "feat: checkout";
const ATTRIBUTIONS: TicketAttribution[] = ["assignee", "author", "closer"];
const COLLABORATION_CASES: [TicketAttribution, string][] = [
    ["assignee", "dev-two"],
    ["author", "dev-one"],
    ["closer", "dev-three"],
];

// Who carries each FIXTURE ticket, hand-derived per mode and listed in the
// output's own author order. The team totals are identical across all three, so
// only this split can tell a correct mode map from a swapped one.
const FIXTURE_SPLITS: Record<TicketAttribution, [string, number, number][]> = {
    assignee: [
        ["dev-three", 2, 0],
        ["dev-two", 2, 2],
    ],
    author: [
        ["dev-one", 2, 1],
        ["dev-three", 1, 0],
        ["dev-two", 1, 1],
    ],
    closer: [
        ["dev-three", 2, 1],
        ["dev-two", 1, 1],
    ],
};

function withCache<T>(fn: (handle: Handle) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "spanical-tickets-"));
    const handle = openCache({ cwd: dir });
    try {
        return fn(handle);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

function seedAuthors(handle: Handle): void {
    for (const [name, actor] of [
        ["dev-one", DEV_ONE],
        ["dev-two", DEV_TWO],
        ["dev-three", DEV_THREE],
    ] as const) {
        upsertGithubLogin(
            handle.db,
            actor.login,
            upsertAuthor(handle.db, name)
        );
    }
}

function ticketRow(options: {
    id: string;
    number: number;
    title: string;
    createdAt: string;
    kind?: string;
    repo?: string;
    author?: Actor;
    assignee?: Actor;
    closedBy?: Actor;
    mergedAt?: string;
    closedAt?: string;
    additions?: number;
    deletions?: number;
    reopenedCount?: number;
}): TicketRow {
    const author = options.author ?? null;
    const assignee = options.assignee ?? null;
    const closedBy = options.closedBy ?? null;
    const mergedAt =
        options.mergedAt === undefined ? null : Date.parse(options.mergedAt);
    const closedAt =
        options.closedAt === undefined
            ? mergedAt
            : Date.parse(options.closedAt);
    return {
        nodeId: options.id,
        repo: options.repo ?? REPO,
        kind: options.kind ?? TICKET_KIND.pullRequest,
        number: options.number,
        title: options.title,
        author: author?.login ?? null,
        authorIsBot: author?.isBot ?? false,
        assignee: assignee?.login ?? null,
        assigneeIsBot: assignee?.isBot ?? false,
        closedBy: closedBy?.login ?? null,
        closedByIsBot: closedBy?.isBot ?? false,
        createdAt: Date.parse(options.createdAt),
        closedAt,
        mergedAt,
        updatedAt: Date.parse(options.createdAt),
        state: mergedAt === null ? "OPEN" : "MERGED",
        reopenedCount: options.reopenedCount ?? 0,
        additions: options.additions ?? null,
        deletions: options.deletions ?? null,
    };
}

function seedTickets(handle: Handle, rows: TicketRow[]): void {
    handle.db.insert(tickets).values(rows).run();
}

function aggregate(
    handle: Handle,
    attribution: TicketAttribution,
    includeIssues = true
) {
    return aggregateTickets(handle.db, {
        window: WINDOW,
        repos: [REPO],
        attribution,
        timezone: "UTC",
        includeIssues,
    });
}

function seedSyncFloor(handle: Handle, since: string): void {
    handle.db
        .insert(githubSyncs)
        .values({
            repo: REPO,
            slug: "acme/web",
            since,
            syncedThrough: 0,
            issuesSyncedThrough: 0,
            syncedAt: 0,
        })
        .run();
}

function devNamed(
    devs: DevTicketRollup[],
    author: string
): DevTicketRollup | undefined {
    return devs.find((dev) => dev.author === author);
}

function render(
    result: TicketAggregation,
    format: RenderFormat,
    layout?: MarkdownLayout
): string {
    return renderTicketsReport(
        format,
        result,
        { window: WINDOW.label, repos: [REPO] },
        layout
    );
}

// One ticket, three different people on it: the mode decides who carries it.
const COLLABORATED = ticketRow({
    id: "pr-1",
    number: 1,
    title: CHECKOUT_TITLE,
    author: DEV_ONE,
    assignee: DEV_TWO,
    closedBy: DEV_THREE,
    createdAt: "2026-07-01T00:00:00Z",
    mergedAt: "2026-07-01T10:00:00Z",
    additions: 40,
    deletions: 10,
    reopenedCount: 1,
});

const FIXTURE: TicketRow[] = [
    COLLABORATED,
    ticketRow({
        id: "pr-2",
        number: 2,
        title: "fix: totals",
        author: DEV_TWO,
        assignee: DEV_TWO,
        closedBy: DEV_TWO,
        createdAt: "2026-07-02T00:00:00Z",
        mergedAt: "2026-07-02T20:00:00Z",
        additions: 300,
        deletions: 200,
    }),
    ticketRow({
        id: "pr-3",
        number: 3,
        title: "chore: bump deps",
        author: BOT,
        assignee: BOT,
        closedBy: BOT,
        createdAt: "2026-07-03T00:00:00Z",
        mergedAt: "2026-07-03T02:00:00Z",
        additions: 4,
        deletions: 1,
    }),
    ticketRow({
        id: "issue-4",
        number: 4,
        kind: TICKET_KIND.issue,
        title: "plan: pricing",
        author: DEV_ONE,
        assignee: DEV_THREE,
        createdAt: "2026-07-04T00:00:00Z",
    }),
    ticketRow({
        id: "pr-5",
        number: 5,
        title: "spike: cache",
        author: DEV_THREE,
        assignee: DEV_THREE,
        closedBy: DEV_THREE,
        createdAt: "2026-07-05T00:00:00Z",
        closedAt: "2026-07-06T00:00:00Z",
    }),
];

test.each(COLLABORATION_CASES)(
    "%s attribution credits a collaborated ticket to exactly one author",
    (attribution, expected) => {
        withCache((handle) => {
            seedAuthors(handle);
            seedTickets(handle, [COLLABORATED]);

            const result = aggregate(handle, attribution);

            expect(result.devs).toHaveLength(1);
            expect(result.devs[0]?.author).toBe(expected);
            expect(result.devs[0]?.opened).toBe(1);
            expect(result.devs[0]?.merged).toBe(1);
            expect(result.devs[0]?.closed).toBe(0);
            expect(result.devs[0]?.reopened).toBe(1);
            expect(result.team.opened).toBe(1);
            expect(result.team.merged).toBe(1);
        });
    }
);

test("every attribution mode leaves the team totals untouched but moves the split", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        for (const attribution of ATTRIBUTIONS) {
            const { team, devs, unattributed } = aggregate(handle, attribution);
            expect(team.opened).toBe(5);
            expect(team.merged).toBe(3);
            expect(team.closed).toBe(1);
            expect(
                devs.map((dev) => [dev.author, dev.opened, dev.merged])
            ).toEqual(FIXTURE_SPLITS[attribution]);
            expect(devs.reduce((sum, dev) => sum + dev.opened, 0)).toBe(
                team.opened - unattributed.opened
            );
        }
    });
});

test("a merged pull request counts as merged and never again as closed", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        const { team, devs } = aggregate(handle, "author");
        expect(team.merged).toBe(3);
        expect(team.closed).toBe(1);
        expect(devNamed(devs, "dev-three")?.closed).toBe(1);
        expect(devNamed(devs, "dev-one")?.closed).toBe(0);
    });
});

test("bot-credited tickets stay out of every per-dev row but count for the team", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        const { devs, team, unattributed } = aggregate(handle, "author");
        expect(devs.map((dev) => dev.author)).toEqual([
            "dev-one",
            "dev-three",
            "dev-two",
        ]);
        expect(team.merged).toBe(3);
        expect(unattributed.opened).toBe(1);
        expect(unattributed.merged).toBe(1);
    });
});

test("cycle time and pull request size report medians over the merged window", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        const { team, devs } = aggregate(handle, "author");
        // Human merges run 10h and 20h over 50 and 500 lines; the bot's 2h
        // 5-line bump counts as merged but never moves a flow median.
        expect(team.cycleTimeMedianHours).toBe(15);
        expect(team.pullRequestSizeMedian).toBe(275);
        expect(devNamed(devs, "dev-one")?.cycleTimeMedianHours).toBe(10);
        expect(devNamed(devs, "dev-one")?.pullRequestSizeMedian).toBe(50);
        expect(devNamed(devs, "dev-two")?.cycleTimeMedianHours).toBe(20);
        expect(devNamed(devs, "dev-three")?.cycleTimeMedianHours).toBeNull();
        expect(devNamed(devs, "dev-three")?.pullRequestSizeMedian).toBeNull();
    });
});

test("an even number of merged pull requests averages the two middle samples", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            COLLABORATED,
            ticketRow({
                id: "pr-2",
                number: 2,
                title: "fix: totals",
                author: DEV_ONE,
                createdAt: "2026-07-02T00:00:00Z",
                mergedAt: "2026-07-02T20:00:00Z",
                additions: 300,
                deletions: 200,
            }),
        ]);

        const { team } = aggregate(handle, "author");
        expect(team.cycleTimeMedianHours).toBe(15);
        expect(team.pullRequestSizeMedian).toBe(275);
    });
});

test("the size distribution buckets every merged pull request exactly once", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        const { pullRequestSizes } = aggregate(handle, "author");
        // The bot's 5-line bump would otherwise fill the 0-9 bucket.
        expect(
            pullRequestSizes.map((bucket) => [
                bucket.label,
                bucket.pullRequests,
            ])
        ).toEqual([
            ["0-9", 0],
            ["10-99", 1],
            ["100-499", 0],
            ["500-999", 1],
            ["1000+", 0],
        ]);
        expect(
            pullRequestSizes.reduce(
                (sum, bucket) => sum + bucket.pullRequests,
                0
            )
        ).toBe(2);
        expect(pullRequestSizes[1]?.share).toBeCloseTo(0.5);
    });
});

test("tickets outside the window are excluded from every count", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-old",
                number: 9,
                title: "feat: last month",
                author: DEV_ONE,
                createdAt: "2026-06-01T00:00:00Z",
                mergedAt: "2026-06-02T00:00:00Z",
                additions: 10,
                deletions: 0,
            }),
        ]);

        const { team, devs } = aggregate(handle, "author");
        expect(team.opened).toBe(0);
        expect(team.merged).toBe(0);
        expect(devs).toEqual([]);
    });
});

test("a revert charges the thrash to the reverted author, not the reverter", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            COLLABORATED,
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                assignee: DEV_TWO,
                closedBy: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
                additions: 10,
                deletions: 40,
            }),
        ]);

        const { devs, team } = aggregate(handle, "author");
        expect(devNamed(devs, "dev-one")?.reverted).toBe(1);
        expect(devNamed(devs, "dev-two")?.reverted).toBe(0);
        expect(team.reverted).toBe(1);
        expect(team.unmatchedReverts).toBe(0);
    });
});

test("a revert matches the reverted pull request under every attribution mode", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            COLLABORATED,
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                assignee: DEV_TWO,
                closedBy: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        expect(
            devNamed(aggregate(handle, "assignee").devs, "dev-two")?.reverted
        ).toBe(1);
        expect(
            devNamed(aggregate(handle, "closer").devs, "dev-three")?.reverted
        ).toBe(1);
    });
});

test("a revert with no cached original counts at team level and credits nobody", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: 'Revert "a pull request nobody cached"',
                author: DEV_TWO,
                assignee: DEV_TWO,
                closedBy: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { devs, team, unattributed } = aggregate(handle, "author");
        expect(team.reverted).toBe(1);
        expect(team.unmatchedReverts).toBe(1);
        expect(devNamed(devs, "dev-two")?.reverted).toBe(0);
        expect(unattributed.reverted).toBe(1);
    });
});

test("a revert never pairs with a same-titled pull request from another repo", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-other-repo",
                repo: "api",
                number: 1,
                title: CHECKOUT_TITLE,
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
                mergedAt: "2026-07-01T10:00:00Z",
            }),
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { team } = aggregate(handle, "author");
        expect(team.unmatchedReverts).toBe(1);
    });
});

test("a pull request merely titled like a revert is matched, not thrown at", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-quoted",
                number: 7,
                title: 'Revert "the "quoted" release"',
                author: DEV_ONE,
                createdAt: "2026-07-09T00:00:00Z",
                mergedAt: "2026-07-09T01:00:00Z",
            }),
            ticketRow({
                id: "pr-no-close-quote",
                number: 8,
                title: 'Revert "unterminated',
                author: DEV_ONE,
                createdAt: "2026-07-10T00:00:00Z",
                mergedAt: "2026-07-10T01:00:00Z",
            }),
        ]);

        const { team } = aggregate(handle, "author");
        expect(team.reverted).toBe(1);
        expect(team.unmatchedReverts).toBe(1);
    });
});

test("a repeated title pairs the revert with the newest pull request before it", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-first",
                number: 1,
                title: CHECKOUT_TITLE,
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
                mergedAt: "2026-07-01T10:00:00Z",
            }),
            ticketRow({
                id: "pr-second",
                number: 2,
                title: CHECKOUT_TITLE,
                author: DEV_THREE,
                createdAt: "2026-07-04T00:00:00Z",
                mergedAt: "2026-07-04T10:00:00Z",
            }),
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { devs } = aggregate(handle, "author");
        expect(devNamed(devs, "dev-three")?.reverted).toBe(1);
        expect(devNamed(devs, "dev-one")?.reverted).toBe(0);
    });
});

test("a same-titled pull request that never merged cannot take the thrash", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-merged",
                number: 1,
                title: CHECKOUT_TITLE,
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
                mergedAt: "2026-07-01T10:00:00Z",
            }),
            ticketRow({
                id: "pr-still-open",
                number: 2,
                title: CHECKOUT_TITLE,
                author: DEV_THREE,
                createdAt: "2026-07-04T00:00:00Z",
            }),
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { devs, team } = aggregate(handle, "author");
        expect(devNamed(devs, "dev-one")?.reverted).toBe(1);
        expect(devNamed(devs, "dev-three")?.reverted).toBe(0);
        expect(team.unmatchedReverts).toBe(0);
    });
});

test("a same-titled pull request merged after the revert cannot take the thrash", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-merged",
                number: 1,
                title: CHECKOUT_TITLE,
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
                mergedAt: "2026-07-01T10:00:00Z",
            }),
            ticketRow({
                id: "pr-merged-later",
                number: 2,
                title: CHECKOUT_TITLE,
                author: DEV_THREE,
                createdAt: "2026-07-04T00:00:00Z",
                mergedAt: "2026-07-22T00:00:00Z",
            }),
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { devs } = aggregate(handle, "author");
        expect(devNamed(devs, "dev-one")?.reverted).toBe(1);
        expect(devNamed(devs, "dev-three")?.reverted).toBe(0);
    });
});

test("a revert whose only same-titled pull request never merged credits nobody", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-still-open",
                number: 1,
                title: CHECKOUT_TITLE,
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
            }),
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `Revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { devs, team, unattributed } = aggregate(handle, "author");
        expect(team.reverted).toBe(1);
        // An unmerged original is reported as unmatched rather than charged to
        // its author: the note explains it, a wrong per-dev number would not.
        expect(team.unmatchedReverts).toBe(1);
        expect(devs.every((dev) => dev.reverted === 0)).toBe(true);
        expect(unattributed.reverted).toBe(1);
    });
});

test("a login with no author mapping falls into the unattributed totals", () => {
    withCache((handle) => {
        seedTickets(handle, [COLLABORATED]);

        const { devs, team, unattributed } = aggregate(handle, "author");
        expect(devs).toEqual([]);
        expect(team.opened).toBe(1);
        expect(unattributed.opened).toBe(1);
    });
});

// A bot's pull request merged before the window, reverted inside it by a mapped
// human: the thrash belongs to the bot, so no per-dev row can carry it.
const REVERTED_BOT_WORK: TicketRow[] = [
    ticketRow({
        id: "pr-bot",
        number: 1,
        title: "chore: bump deps",
        author: BOT,
        assignee: BOT,
        closedBy: BOT,
        createdAt: "2026-06-01T00:00:00Z",
        mergedAt: "2026-06-02T00:00:00Z",
        additions: 4,
        deletions: 1,
    }),
    ticketRow({
        id: "pr-revert",
        number: 2,
        title: 'Revert "chore: bump deps"',
        author: DEV_ONE,
        assignee: DEV_ONE,
        closedBy: DEV_ONE,
        createdAt: "2026-07-08T00:00:00Z",
        mergedAt: "2026-07-08T01:00:00Z",
        additions: 1,
        deletions: 4,
    }),
];

test("a revert charged to nobody still reaches the report", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, REVERTED_BOT_WORK);
        const result = aggregate(handle, "author");

        expect(result.team.reverted).toBe(1);
        expect(result.team.unmatchedReverts).toBe(0);
        expect(result.devs.every((dev) => dev.reverted === 0)).toBe(true);
        expect(result.unattributed.reverted).toBe(1);
        // The gap is invisible in opened/merged/closed, so a note that names
        // only those three would leave "1 reverted" unexplained.
        expect(result.unattributed.opened).toBe(0);
        expect(result.unattributed.merged).toBe(0);
        expect(result.unattributed.closed).toBe(0);

        const markdown = render(result, "md");
        expect(markdown).toContain("1 reverted");
        expect(markdown).toContain("no per-dev row does");
    });
});

test("reopens credited to nobody are named in the report", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "issue-bot",
                number: 1,
                kind: TICKET_KIND.issue,
                title: "chore: flaky pipeline",
                author: BOT,
                assignee: BOT,
                createdAt: "2026-07-02T00:00:00Z",
                reopenedCount: 5,
            }),
        ]);
        const result = aggregate(handle, "author");

        expect(result.team.reopened).toBe(5);
        expect(result.unattributed.reopened).toBe(5);
        // Pinned to the note's own phrasing: the team line also says
        // "5 reopened", so a looser match would pass without the note.
        expect(render(result, "md")).toContain("0 closed, 5 reopened");
    });
});

test("bot pull requests never move the team flow medians", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-human",
                number: 1,
                title: "feat: checkout",
                author: DEV_ONE,
                createdAt: "2026-07-01T00:00:00Z",
                mergedAt: "2026-07-02T00:00:00Z",
                additions: 400,
                deletions: 100,
            }),
            ticketRow({
                id: "pr-bot-one",
                number: 2,
                title: "chore: bump one",
                author: BOT,
                createdAt: "2026-07-03T00:00:00Z",
                mergedAt: "2026-07-03T00:01:00Z",
                additions: 1,
                deletions: 1,
            }),
            ticketRow({
                id: "pr-bot-two",
                number: 3,
                title: "chore: bump two",
                author: BOT,
                createdAt: "2026-07-04T00:00:00Z",
                mergedAt: "2026-07-04T00:01:00Z",
                additions: 1,
                deletions: 1,
            }),
        ]);

        const { team, pullRequestSizes } = aggregate(handle, "author");
        expect(team.merged).toBe(3);
        expect(team.cycleTimeMedianHours).toBe(24);
        expect(team.pullRequestSizeMedian).toBe(500);
        expect(
            pullRequestSizes.find((bucket) => bucket.label === "0-9")
                ?.pullRequests
        ).toBe(0);
    });
});

test("a merge stamped before its own creation is tallied, not silently dropped", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "pr-backwards",
                number: 1,
                title: "feat: time travel",
                author: DEV_ONE,
                createdAt: "2026-07-10T00:00:00Z",
                mergedAt: "2026-07-09T00:00:00Z",
                additions: 30,
                deletions: 20,
            }),
        ]);
        const result = aggregate(handle, "author");

        expect(result.team.cycleTimesDiscarded).toBe(1);
        expect(result.team.cycleTimeMedianHours).toBeNull();
        expect(result.team.pullRequestSizeMedian).toBe(50);
        expect(render(result, "md")).toContain(
            "earlier than their own creation"
        );
    });
});

test("a lowercase revert title is counted like the capitalised form", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            COLLABORATED,
            ticketRow({
                id: "pr-revert",
                number: 6,
                title: `revert "${CHECKOUT_TITLE}"`,
                author: DEV_TWO,
                createdAt: "2026-07-08T00:00:00Z",
                mergedAt: "2026-07-08T01:00:00Z",
            }),
        ]);

        const { devs, team } = aggregate(handle, "author");
        expect(team.reverted).toBe(1);
        expect(devNamed(devs, "dev-one")?.reverted).toBe(1);
    });
});

test("a window whose tickets credit nobody states that instead of an empty grid", () => {
    withCache((handle) => {
        seedTickets(handle, [COLLABORATED]);
        const markdown = render(aggregate(handle, "author"), "md");

        expect(markdown).toContain("No per-dev rows");
        expect(markdown).not.toContain("| Author |");
        expect(markdown).toContain("Team: 1 opened");
    });
});

test("an issues-only window drops the merged size section entirely", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, [
            ticketRow({
                id: "issue-1",
                number: 1,
                kind: TICKET_KIND.issue,
                title: "plan: pricing",
                author: DEV_ONE,
                createdAt: "2026-07-04T00:00:00Z",
            }),
        ]);
        const markdown = render(aggregate(handle, "author"), "md");

        expect(markdown).not.toContain("Merged pull request size");
        expect(markdown).toContain("Team: 1 opened");
    });
});

test("the count note discloses whether issues share the opened and closed columns", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        expect(render(aggregate(handle, "author"), "md")).toContain(
            "Opened and closed count pull requests and issues together"
        );
        expect(render(aggregate(handle, "author", false), "md")).toContain(
            "issues are out of scope for this run"
        );
    });
});

test("a sync floor later than the window start is disclosed", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        seedSyncFloor(handle, "2026-07-04");
        const markdown = render(aggregate(handle, "author"), "md");

        expect(markdown).toContain("synced from a later date");
        expect(markdown).toContain("web-app (2026-07-04)");
    });
});

test("an unbounded window discloses the sync floor rather than staying silent", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        seedSyncFloor(handle, "2026-07-01");
        const result = aggregateTickets(handle.db, {
            // The window whose label promises all history is the one a
            // truncated cache misleads most.
            window: { ...WINDOW, start: null, label: "history -> 2026-07" },
            repos: [REPO],
            attribution: "author",
            timezone: "UTC",
            includeIssues: true,
        });

        expect(result.coverage.lateSyncFloors).toEqual([
            { repo: REPO, since: "2026-07-01" },
        ]);
        expect(render(result, "md")).toContain("synced from a later date");
    });
});

test("an empty ticket window still discloses that the cache starts after it", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedSyncFloor(handle, "2026-07-20");
        const markdown = render(aggregate(handle, "author"), "md");

        expect(markdown).toContain("No ticket activity in 2026-07");
        expect(markdown).toContain("synced from a later date");
        expect(markdown).toContain("web-app (2026-07-20)");
    });
});

test("a sync floor at or before the window start is not reported as a gap", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        seedSyncFloor(handle, "2026-06-01");

        expect(aggregate(handle, "author").coverage.lateSyncFloors).toEqual([]);
        expect(render(aggregate(handle, "author"), "md")).not.toContain(
            "synced from a later date"
        );
    });
});

test("json exposes the coverage a consumer needs to compare two runs", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        seedSyncFloor(handle, "2026-07-04");
        const result = aggregate(handle, "author", false);

        // Structured, not prose: a year-over-year diff has to be able to test
        // whether a run covers its whole window without parsing a note.
        expect(result.coverage).toEqual({
            includeIssues: false,
            lateSyncFloors: [{ repo: REPO, since: "2026-07-04" }],
        });
        const parsed: unknown = JSON.parse(render(result, "json"));
        expect(parsed).toHaveProperty(
            ["coverage", "lateSyncFloors", 0, "since"],
            "2026-07-04"
        );
        expect(parsed).toHaveProperty(["coverage", "includeIssues"], false);
        expect(parsed).toHaveProperty(["team", "cycleTimesDiscarded"], 0);
    });
});

test("markdown carries the read flags, the attribution and the revert caveat", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        const result = aggregate(handle, "author");

        const markdown = render(result, "md");
        expect(markdown).toContain("## Ticket flow · credited to the author");
        expect(markdown).toContain("| Author | Opened (volume) |");
        expect(markdown).toContain("Cycle time h (signal)");
        expect(markdown).toContain("Merged pull request size");
        expect(markdown).toContain("Team: 5 opened · 3 merged · 1 closed");
        expect(markdown).toContain("approximate");
        expect(markdown).toContain("no per-dev row does");
    });
});

test("a caller nesting the report deeper controls the table heading level", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        const result = aggregate(handle, "author");

        const markdown = render(result, "md", { titleLevel: 3 });
        expect(markdown).toContain("### Ticket flow · credited to the author");
        expect(markdown).toContain("### Merged pull request size");
        // "### x" contains "## x", so only anchoring to the line start can tell
        // the requested level from the default one.
        expect(markdown).not.toMatch(/^#{1,2} /m);
    });
});

test("the terminal table names every ticket column", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);

        const table = render(aggregate(handle, "author"), "table");
        expect(table).toContain("Opened");
        expect(table).toContain("Reverted");
        expect(table).toContain("Cycle time h");
        expect(table).toContain("dev-one");
    });
});

test("json returns the raw aggregation rather than a rendered grid", () => {
    withCache((handle) => {
        seedAuthors(handle);
        seedTickets(handle, FIXTURE);
        const result = aggregate(handle, "author");

        const parsed: unknown = JSON.parse(render(result, "json"));
        // The suite's one round-trip check: the json format is the payload
        // itself, never a serialised table. Round-tripping holds for any
        // aggregation, so the pinned values below carry the real signal.
        expect(parsed).toEqual(JSON.parse(JSON.stringify(result)));
        expect(parsed).toHaveProperty(["attribution"], "author");
        expect(parsed).toHaveProperty(["team", "opened"], 5);
        expect(parsed).toHaveProperty(["team", "merged"], 3);
        expect(parsed).toHaveProperty(["devs", 0, "author"], "dev-one");
        expect(parsed).toHaveProperty(["devs", 0, "opened"], 2);
        expect(parsed).toHaveProperty(["unattributed", "merged"], 1);
    });
});

test("an empty ticket window says so instead of rendering an empty grid", () => {
    withCache((handle) => {
        seedAuthors(handle);
        const result = aggregate(handle, "author");

        for (const format of ["table", "md"] as const) {
            const output = render(result, format);
            expect(output).toContain("No ticket activity in 2026-07");
            expect(output).toContain(REPO);
            expect(output).not.toContain("Opened");
        }
        // json has no empty-window prose to fall back on, so it has to carry
        // the zeroes and the empty row set explicitly.
        const parsed: unknown = JSON.parse(render(result, "json"));
        expect(parsed).toHaveProperty(["devs"], []);
        expect(parsed).toHaveProperty(["team", "opened"], 0);
        expect(parsed).toHaveProperty(["team", "cycleTimeMedianHours"], null);
    });
});
