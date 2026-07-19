import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache/open";
import { authors, commitAuthors, commits, fileChanges } from "../cache/schema";
import type { Period, ResolvedWindow } from "../window/types";
import { aggregateTimeline } from "./timeline";
import type { TimelineEvent, TimelinePeriod } from "./types";

function monthPeriod(year: number, monthIndex: number, label: string): Period {
    return {
        label,
        start: new Date(Date.UTC(year, monthIndex, 1)),
        end: new Date(Date.UTC(year, monthIndex + 1, 1)),
    };
}

const P1 = monthPeriod(2025, 0, "2025-01");
const P2 = monthPeriod(2025, 1, "2025-02");
const P3 = monthPeriod(2025, 2, "2025-03");
const P4 = monthPeriod(2025, 3, "2025-04");
const P5 = monthPeriod(2025, 4, "2025-05");
const P6 = monthPeriod(2025, 5, "2025-06");

const WINDOW: ResolvedWindow = {
    start: P1.start,
    end: P6.end,
    granularity: "month",
    periods: [P1, P2, P3, P4, P5, P6],
    label: "2025-01..2025-06",
};

const REPO = "web-app";

function git(cwd: string, args: string[]): string {
    const result = Bun.spawnSync(["git", ...args], { cwd });
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args.join(" ")} failed: ${result.stderr.toString()}`
        );
    }
    return result.stdout.toString();
}

function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-timeline-repo-"));
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "ci"]);
    git(dir, ["config", "user.email", "ci@example.com"]);
    git(dir, ["config", "commit.gpgsign", "false"]);
    return dir;
}

let commitCounter = 0;

function commitWithSubject(dir: string, subject: string): string {
    commitCounter += 1;
    writeFileSync(join(dir, `file-${commitCounter}.txt`), `${subject}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", subject]);
    return git(dir, ["rev-parse", "HEAD"]).trim();
}

function fileChange(sha: string, added: number, deleted: number) {
    return {
        sha,
        repo: REPO,
        path: `src/${sha}.ts`,
        added,
        deleted,
        isBinary: false,
        isMigration: false,
    };
}

type Fixture = {
    handle: ReturnType<typeof openCache>;
    cacheDir: string;
    repoDir: string;
    shas: { xb: string; h: string; f: string; a: string };
};

function seedFixture(): Fixture {
    const repoDir = initRepo();
    const xb = commitWithSubject(repoDir, "add config module");
    const h = commitWithSubject(repoDir, "remove legacy module");
    const f = commitWithSubject(repoDir, "restructure module");
    const a = commitWithSubject(repoDir, "add feature");

    const cacheDir = mkdtempSync(join(tmpdir(), "spanical-timeline-cache-"));
    const handle = openCache({ cwd: cacheDir });
    const { db } = handle;

    db.insert(authors).values([{ id: 1, canonicalName: "dev-one" }]).run();

    const authoredP2 = Date.UTC(2025, 1, 15);
    const authoredP3 = Date.UTC(2025, 2, 15);
    const authoredP4 = Date.UTC(2025, 3, 15);
    const authoredP5 = Date.UTC(2025, 4, 15);

    db.insert(commits)
        .values([
            { sha: xb, repo: REPO, authorId: 1, authoredAt: authoredP2, isMerge: false },
            { sha: "yb", repo: REPO, authorId: 1, authoredAt: authoredP2, isMerge: false },
            { sha: "zb", repo: REPO, authorId: 1, authoredAt: authoredP2, isMerge: false },
            { sha: h, repo: REPO, authorId: 1, authoredAt: authoredP3, isMerge: false },
            { sha: f, repo: REPO, authorId: 1, authoredAt: authoredP4, isMerge: false },
            { sha: a, repo: REPO, authorId: 1, authoredAt: authoredP5, isMerge: false },
        ])
        .run();

    db.insert(commitAuthors)
        .values([xb, "yb", "zb", h, f, a].map((sha) => ({ sha, authorId: 1, weight: 1.0 })))
        .run();

    db.insert(fileChanges)
        .values([
            fileChange(xb, 40, 0),
            fileChange("yb", 0, 35),
            fileChange("zb", 25, 0),
            fileChange(h, 10, 90),
            fileChange(f, 200, 200),
            fileChange(a, 90, 10),
        ])
        .run();

    return { handle, cacheDir, repoDir, shas: { xb, h, f, a } };
}

async function runTimeline(fixture: Fixture): Promise<TimelinePeriod[]> {
    return aggregateTimeline(fixture.handle.db, {
        window: WINDOW,
        repos: [{ name: REPO, path: fixture.repoDir }],
    });
}

function cleanup(fixture: Fixture): void {
    fixture.handle.sqlite.close();
    rmSync(fixture.cacheDir, { recursive: true, force: true });
    rmSync(fixture.repoDir, { recursive: true, force: true });
}

function dominantEvent(events: TimelineEvent[]): Extract<
    TimelineEvent,
    { kind: "dominant-commit" }
> {
    const event = events.find((candidate) => candidate.kind === "dominant-commit");
    if (event === undefined || event.kind !== "dominant-commit") {
        throw new Error("expected a dominant-commit event");
    }
    return event;
}

test("flags a dominant commit at the 0.4 boundary and fetches its subject", async () => {
    const fixture = seedFixture();
    try {
        const rows = await runTimeline(fixture);
        const p2 = rows[1];
        expect(p2?.period).toBe("2025-02");
        expect(p2?.throughput).toBe(100);
        expect(p2?.commits).toBe(3);
        expect(p2?.activeDevs).toBe(1);

        const dominants = (p2?.events ?? []).filter(
            (event) => event.kind === "dominant-commit"
        );
        expect(dominants).toHaveLength(1);

        const dominant = dominantEvent(p2?.events ?? []);
        expect(dominant.share).toBeCloseTo(0.4, 10);
        expect(dominant.subtype).toBe("landing");
        expect(dominant.sha).toBe(fixture.shas.xb.slice(0, 7));
        expect(dominant.subject).toBe("add config module");
    } finally {
        cleanup(fixture);
    }
});

test("classifies removal, restructure, and landing dominant subtypes", async () => {
    const fixture = seedFixture();
    try {
        const rows = await runTimeline(fixture);

        const removal = dominantEvent(rows[2]?.events ?? []);
        expect(removal.subtype).toBe("removal");
        expect(removal.subject).toBe("remove legacy module");

        const restructure = dominantEvent(rows[3]?.events ?? []);
        expect(restructure.subtype).toBe("restructure");
        expect(restructure.subject).toBe("restructure module");

        const landing = dominantEvent(rows[4]?.events ?? []);
        expect(landing.subtype).toBe("landing");
        expect(landing.subject).toBe("add feature");
    } finally {
        cleanup(fixture);
    }
});

test("marks the net-negative non-trivial period as a removal period", async () => {
    const fixture = seedFixture();
    try {
        const rows = await runTimeline(fixture);
        const p3 = rows[2];
        expect(p3?.net).toBe(-80);
        expect(
            (p3?.events ?? []).some((event) => event.kind === "removal")
        ).toBe(true);
    } finally {
        cleanup(fixture);
    }
});

test("flags the churn-spike period with its multiple of the median", async () => {
    const fixture = seedFixture();
    try {
        const rows = await runTimeline(fixture);
        const p4 = rows[3];
        expect(p4?.throughput).toBe(400);
        const spike = (p4?.events ?? []).find(
            (event) => event.kind === "churn-spike"
        );
        expect(spike?.kind).toBe("churn-spike");
        if (spike?.kind === "churn-spike") {
            expect(spike.multiple).toBeCloseTo(4, 10);
        }
    } finally {
        cleanup(fixture);
    }
});

test("anchors a busiest event on the single max-throughput period", async () => {
    const fixture = seedFixture();
    try {
        const rows = await runTimeline(fixture);
        const busiestCount = rows.filter((row) =>
            row.events.some((event) => event.kind === "busiest")
        );
        expect(busiestCount).toHaveLength(1);
        expect(busiestCount[0]?.period).toBe("2025-04");
    } finally {
        cleanup(fixture);
    }
});

test("emits no events for empty periods and excludes sub-threshold commits", async () => {
    const fixture = seedFixture();
    try {
        const rows = await runTimeline(fixture);
        expect(rows[0]?.events ?? []).toHaveLength(0);
        expect(rows[0]?.activeDevs).toBe(0);
        expect(rows[5]?.events ?? []).toHaveLength(0);
    } finally {
        cleanup(fixture);
    }
});

test("returns an empty timeline when the window has no periods", async () => {
    const fixture = seedFixture();
    try {
        const rows = await aggregateTimeline(fixture.handle.db, {
            window: {
                start: null,
                end: P6.end,
                granularity: "month",
                periods: [],
                label: "empty",
            },
            repos: [{ name: REPO, path: fixture.repoDir }],
        });
        expect(rows).toHaveLength(0);
    } finally {
        cleanup(fixture);
    }
});
