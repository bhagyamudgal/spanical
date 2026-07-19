import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateAll, aggregatePerDev } from "../aggregate";
import { openCache } from "../cache/open";
import {
    authors,
    commitAuthors,
    commits,
    fileChanges,
    sccSnapshots,
} from "../cache/schema";
import type { ResolvedRun } from "../cli/resolve-run";
import type { Period, ResolvedWindow } from "../window/types";
import { buildReportArtifact } from "./artifact";
import { defaultReportPath } from "./filename";

const P1: Period = {
    label: "2025-06",
    start: new Date(Date.UTC(2025, 5, 1)),
    end: new Date(Date.UTC(2025, 6, 1)),
};
const P2: Period = {
    label: "2025-07",
    start: new Date(Date.UTC(2025, 6, 1)),
    end: new Date(Date.UTC(2025, 7, 1)),
};

const WINDOW: ResolvedWindow = {
    start: P1.start,
    end: P2.end,
    granularity: "month",
    periods: [P1, P2],
    label: "2025-06 – 2025-07",
};

const RUN: ResolvedRun = {
    repos: [{ name: "web-app", path: "/tmp/web-app" }],
    tz: "UTC",
    exclude: [],
    by: "dev",
    format: "md",
    out: null,
    cache: true,
    window: WINDOW,
};

function seedFixture(): { handle: ReturnType<typeof openCache>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "spanical-report-"));
    const handle = openCache({ cwd: dir });
    const { db } = handle;

    db.insert(authors)
        .values([
            { id: 1, canonicalName: "dev-one" },
            { id: 2, canonicalName: "dev-two" },
        ])
        .run();

    db.insert(commits)
        .values([
            {
                sha: "c1",
                repo: "web-app",
                authorId: 1,
                authoredAt: Date.UTC(2025, 5, 10),
                isMerge: false,
            },
            {
                sha: "c2",
                repo: "web-app",
                authorId: 1,
                authoredAt: Date.UTC(2025, 6, 5),
                isMerge: false,
            },
            {
                sha: "c3",
                repo: "web-app",
                authorId: 2,
                authoredAt: Date.UTC(2025, 6, 20),
                isMerge: false,
            },
            {
                sha: "c4",
                repo: "web-app",
                authorId: 1,
                authoredAt: Date.UTC(2025, 6, 25),
                isMerge: false,
            },
        ])
        .run();

    db.insert(commitAuthors)
        .values([
            { sha: "c1", authorId: 1, weight: 1.0 },
            { sha: "c2", authorId: 1, weight: 0.5 },
            { sha: "c2", authorId: 2, weight: 0.5 },
            { sha: "c3", authorId: 2, weight: 1.0 },
            { sha: "c4", authorId: 1, weight: 1.0 },
        ])
        .run();

    db.insert(fileChanges)
        .values([
            {
                sha: "c1",
                repo: "web-app",
                path: "src/a.ts",
                added: 10,
                deleted: 2,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c2",
                repo: "web-app",
                path: "src/a.ts",
                added: 5,
                deleted: 5,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c2",
                repo: "web-app",
                path: "src/b.ts",
                added: 20,
                deleted: 0,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c3",
                repo: "web-app",
                path: "db/migrations/001.sql",
                added: 100,
                deleted: 0,
                isBinary: false,
                isMigration: true,
            },
            {
                sha: "c3",
                repo: "web-app",
                path: "src/c.ts",
                added: 3,
                deleted: 1,
                isBinary: false,
                isMigration: false,
            },
            {
                sha: "c3",
                repo: "web-app",
                path: "assets/x.png",
                added: null,
                deleted: null,
                isBinary: true,
                isMigration: false,
            },
            {
                sha: "c4",
                repo: "web-app",
                path: "db/migrations/002.sql",
                added: 50,
                deleted: 0,
                isBinary: false,
                isMigration: true,
            },
        ])
        .run();

    db.insert(sccSnapshots)
        .values([
            {
                repo: "web-app",
                month: "2025-06",
                path: "src/a.ts",
                language: "TypeScript",
                code: 20,
                complexity: 3,
                sha: "c1",
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "src/a.ts",
                language: "TypeScript",
                code: 25,
                complexity: 4,
                sha: "c2",
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "src/b.ts",
                language: "TypeScript",
                code: 30,
                complexity: 5,
                sha: "c2",
            },
            {
                repo: "web-app",
                month: "2025-07",
                path: "db/migrations/001.sql",
                language: "SQL",
                code: 8,
                complexity: 0,
                sha: "c2",
            },
        ])
        .run();

    return { handle, dir };
}

function buildArtifact(handle: ReturnType<typeof openCache>): string {
    const full = aggregateAll(handle.db, {
        window: WINDOW,
        timezone: "UTC",
        repos: ["web-app"],
    });
    const contributors = aggregatePerDev(handle.db, {
        periods: [{ label: WINDOW.label, start: P1.start, end: P2.end }],
        timezone: "UTC",
    });
    return buildReportArtifact({ full, contributors, run: RUN });
}

test("buildReportArtifact composes the headline report from the oracle fixture", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("# Engineering report — 2025-06 – 2025-07");

        expect(artifact).toContain("Net growth");
        expect(artifact).toContain("+30 LOC");
        expect(artifact).toContain("Total now");
        expect(artifact).toContain("63 LOC");
        expect(artifact).toContain("46 lines");
        expect(artifact).toContain("4 (no-merge)");
        expect(artifact).toContain("Active devs");
        expect(artifact).toContain("Busiest month");
        expect(artifact).toContain("2025-07");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact includes every headline section", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("## Activity by period");
        expect(artifact).toContain("## Migrations");
        expect(artifact).toContain("## Contributors");
        expect(artifact).toContain("## Size & complexity");
        expect(artifact).toContain("## Per-repo appendix");
        expect(artifact).toContain("### web-app");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact renders the activity table with the busiest period row", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);
        const activityRow = artifact
            .split("\n")
            .find((line) => line.startsWith("| 2025-07 |"));

        expect(activityRow).toBeDefined();
        expect(activityRow).toContain("| 3 |");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact reports migrations churn tracked separately", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain(
            "Migrations churn: +150 / -0 (150 lines, tracked separately from main churn)"
        );
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("buildReportArtifact lists both contributors with flag markers", () => {
    const { handle, dir } = seedFixture();
    try {
        const artifact = buildArtifact(handle);

        expect(artifact).toContain("dev-one");
        expect(artifact).toContain("dev-two");
        expect(artifact).toContain("(signal)");
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("defaultReportPath derives a start_end slug from window boundaries", () => {
    const window: ResolvedWindow = {
        start: new Date(Date.UTC(2025, 5, 1)),
        end: new Date(Date.UTC(2025, 6, 15)),
        granularity: "month",
        periods: [],
        label: "x",
    };

    expect(defaultReportPath(window, "UTC", "/tmp/work")).toBe(
        join("/tmp/work", "spanical-report-2025-06_2025-07.md")
    );
});

test("defaultReportPath uses a history slug when the window has no start", () => {
    const window: ResolvedWindow = {
        start: null,
        end: new Date(Date.UTC(2025, 6, 15)),
        granularity: "month",
        periods: [],
        label: "x",
    };

    expect(defaultReportPath(window, "UTC", "/tmp/work")).toBe(
        join("/tmp/work", "spanical-report-history_2025-07.md")
    );
});
