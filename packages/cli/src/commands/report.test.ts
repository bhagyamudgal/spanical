import { test as runFlags } from "@drizzle-team/brocli";
import { expect, test } from "bun:test";
import type { ResolvedRun } from "../cli/resolve-run";
import type { Granularity } from "../window";
import { formatRunHeader, reportCommand } from "./report";

function buildRun(input: {
    repoCount: number;
    granularity: Granularity;
    label: string;
    tz: string;
}): ResolvedRun {
    const repos = Array.from({ length: input.repoCount }, (_, index) => ({
        name: `repo-${index}`,
        path: `../repo-${index}`,
    }));
    return {
        repos,
        tz: input.tz,
        exclude: [],
        by: "dev",
        format: "table",
        out: null,
        cache: true,
        window: {
            start: new Date("2026-06-18T12:00:00Z"),
            end: new Date("2026-07-18T12:00:00Z"),
            granularity: input.granularity,
            periods: [],
            label: input.label,
        },
    };
}

test("formats a single weekly repo header with singular repo label", () => {
    const run = buildRun({
        repoCount: 1,
        granularity: "week",
        label: "last 30d (2026-06 → 2026-07)",
        tz: "UTC",
    });
    const header = formatRunHeader(run);
    expect(header).toBe("last 30d (2026-06 → 2026-07) · weekly · 1 repo · UTC");
    expect(header).toContain("last 30d");
    expect(header).toContain("weekly");
});

test("formats two monthly repos header with pluralized repo label", () => {
    const run = buildRun({
        repoCount: 2,
        granularity: "month",
        label: "last 12m (2025-07 → 2026-07)",
        tz: "UTC",
    });
    const header = formatRunHeader(run);
    expect(header).toBe(
        "last 12m (2025-07 → 2026-07) · monthly · 2 repos · UTC"
    );
    expect(header).toContain("last 12m");
    expect(header).toContain("monthly");
});

test("spreads globalFlags into the report command options", async () => {
    const result = await runFlags(
        reportCommand,
        "--last 30d --repo ../web-app"
    );
    expect(result.type).toBe("handler");
    if (result.type === "handler") {
        expect(result.options.last).toBe("30d");
        expect(result.options.repo).toBe("../web-app");
    }
});
