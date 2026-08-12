import { expect, test } from "bun:test";
import type {
    DevPeriodRollup,
    HotspotRow,
    OwnershipAggregation,
    PeriodRollup,
    SizeTrendPoint,
    TimelinePeriod,
} from "../aggregate/types";
import {
    renderHotspotsReport,
    renderOwnershipReport,
    renderSizeReport,
    renderTimelineReport,
} from ".";
import { formatCell } from "./format";
import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import {
    churnPeriodTable,
    devTable,
    hotspotsTable,
    sizeTable,
    timelineTable,
} from "./tables";
import { renderTable } from "./terminal";

const churnRows: PeriodRollup[] = [
    {
        period: "2025-06",
        commits: 3,
        added: 1200,
        deleted: 340,
        net: 860,
        throughput: 1540,
        migrationsAdded: 50,
        migrationsDeleted: 0,
    },
    {
        period: "2025-07",
        commits: 12,
        added: 2500,
        deleted: 1500,
        net: 1000,
        throughput: 4000,
        migrationsAdded: 0,
        migrationsDeleted: 10,
    },
];

const devRows: DevPeriodRollup[] = [
    {
        period: "2025-07",
        authorId: 1,
        author: "dev-one",
        commits: 40,
        added: 5000,
        deleted: 1200,
        net: 3800,
        throughput: 6200,
        filesTouched: 85,
        avgCommitSize: 7.5,
        activeDays: 15,
    },
    {
        period: "2025-07",
        authorId: 2,
        author: "dev-two",
        commits: 3,
        added: 90,
        deleted: 12,
        net: 78,
        throughput: 102,
        filesTouched: 8,
        avgCommitSize: null,
        activeDays: 2,
    },
];

const sizeRows: SizeTrendPoint[] = [
    {
        month: "2025-07",
        totalCode: 12000,
        totalComplexity: 640,
        languages: [
            { language: "TypeScript", code: 55 },
            { language: "SQL", code: 8 },
        ],
    },
];

const hotspotRows: HotspotRow[] = [
    {
        repo: "web-app",
        path: "src/app.ts",
        changeFrequency: 3,
        complexity: 8,
        freqNorm: 1,
        cxNorm: 0.75,
        score: 0.75,
        ownerCount: 2,
    },
];

const timelineRows: TimelinePeriod[] = [
    {
        period: "2025-07",
        net: 10,
        throughput: 20,
        commits: 2,
        activeDevs: 1,
        events: [],
    },
];

const sharedOwnership: OwnershipAggregation = {
    files: [
        {
            repo: "web-app",
            path: "src/app.ts",
            totalLines: 100,
            ownerCount: 2,
            primaryOwner: "dev-one",
            primaryShare: 0.6,
            isSoleOwned: false,
            soleOwner: null,
            shares: [
                { author: "dev-one", survivingLines: 60, share: 0.6 },
                { author: "dev-two", survivingLines: 40, share: 0.4 },
            ],
        },
    ],
    busFactor: [],
};

test("formatCell renders null, integers, and decimals", () => {
    expect(formatCell(null)).toBe("-");
    expect(formatCell(1234)).toBe("1,234");
    expect(formatCell(7.5)).toBe("7.5");
    expect(formatCell("dev-one")).toBe("dev-one");
});

test("churnPeriodTable markdown right-aligns numerics and formats thousands", () => {
    const expected = [
        "| Period | Commits | Added | Deleted | Net | Throughput | Migrations |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        "| 2025-06 | 3 | 1,200 | 340 | 860 | 1,540 | 50 |",
        "| 2025-07 | 12 | 2,500 | 1,500 | 1,000 | 4,000 | 10 |",
    ].join("\n");
    expect(renderMarkdown(churnPeriodTable(churnRows))).toBe(expected);
});

test("devTable markdown carries flag markers and the legend", () => {
    const expected = [
        "| Author | Commits (volume) | Lines added (volume) | Lines deleted (volume) | Net lines (volume) | Throughput churn (context) | Files touched (context) | Avg commit size (signal) | Active days (signal) |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        "| dev-one | 40 | 5,000 | 1,200 | 3,800 | 6,200 | 85 | 7.5 | 15 |",
        "| dev-two | 3 | 90 | 12 | 78 | 102 | 8 | - | 2 |",
        "",
        "_flags: (signal) safe to read per-dev · (context) needs interpretation · (volume) narrative only, not a ranking_",
    ].join("\n");
    expect(renderMarkdown(devTable(devRows))).toBe(expected);
});

test("devTable json preserves null and non-integer avg commit size", () => {
    const expected = [
        "[",
        "    {",
        '        "period": "2025-07",',
        '        "authorId": 1,',
        '        "author": "dev-one",',
        '        "commits": 40,',
        '        "added": 5000,',
        '        "deleted": 1200,',
        '        "net": 3800,',
        '        "throughput": 6200,',
        '        "filesTouched": 85,',
        '        "avgCommitSize": 7.5,',
        '        "activeDays": 15',
        "    },",
        "    {",
        '        "period": "2025-07",',
        '        "authorId": 2,',
        '        "author": "dev-two",',
        '        "commits": 3,',
        '        "added": 90,',
        '        "deleted": 12,',
        '        "net": 78,',
        '        "throughput": 102,',
        '        "filesTouched": 8,',
        '        "avgCommitSize": null,',
        '        "activeDays": 2',
        "    }",
        "]",
    ].join("\n");
    expect(renderJson(devRows)).toBe(expected);
});

test("sizeTable markdown renders the compact languages string", () => {
    const expected = [
        "| Month | Total code | Total complexity | Languages |",
        "| --- | ---: | ---: | --- |",
        "| 2025-07 | 12,000 | 640 | TypeScript 55, SQL 8 |",
    ].join("\n");
    expect(renderMarkdown(sizeTable(sizeRows))).toBe(expected);
});

test("renderTable output contains the column labels", () => {
    const output = renderTable(churnPeriodTable(churnRows));
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("Period");
    expect(output).toContain("Commits");
    expect(output).toContain("Migrations");
});

test("empty insight reports explain the measured state without changing JSON", () => {
    expect(
        renderHotspotsReport("md", [], {
            minFileLines: 50,
            unmeasuredRepos: [],
        })
    ).toBe(
        "No hotspots: no eligible non-binary, non-migration file both changed in the selected window and had at least 50 code lines in its window-end SCC snapshot."
    );
    expect(renderSizeReport("table", [], { unmeasuredRepos: [] })).toBe(
        "No size trend: no monthly boundary SCC snapshot data was available for the selected repositories."
    );
    expect(renderTimelineReport("md", [], { windowStart: null })).toBe(
        "No timeline periods: an open-start history window has no bounded periods to plot."
    );
    expect(
        renderOwnershipReport(
            "table",
            { files: [], busFactor: [] },
            { minFileLines: 50, busFactorThreshold: 0.8 }
        )
    ).toContain(
        "No ownership data: no surviving blame rows were available for files with at least 50 code lines."
    );

    expect(
        renderHotspotsReport("json", [], {
            minFileLines: 50,
            unmeasuredRepos: ["web-app"],
        })
    ).toBe("[]");
    expect(renderSizeReport("json", [], { unmeasuredRepos: ["web-app"] })).toBe(
        "[]"
    );
    expect(renderTimelineReport("json", [], { windowStart: null })).toBe("[]");
    expect(
        JSON.parse(
            renderOwnershipReport(
                "json",
                { files: [], busFactor: [] },
                { minFileLines: 50, busFactorThreshold: 0.8 }
            )
        )
    ).toEqual({ files: [], busFactor: [] });
});

test("ownership keeps file rows when only the bus-factor map is empty", () => {
    const output = renderOwnershipReport("md", sharedOwnership, {
        minFileLines: 50,
        busFactorThreshold: 0.8,
    });

    expect(output).toContain(
        "| web-app/src/app.ts | 100 | dev-one | 60% | 2 | - |"
    );
    expect(output).toContain(
        "No bus-factor warnings: no file met the 80% sole-ownership threshold."
    );
    expect(output).not.toContain("| Repo | Directory | Sole-owned files |");
});

test("hotspots disclose repositories without a window-end snapshot", () => {
    expect(
        renderHotspotsReport("md", [], {
            minFileLines: 50,
            unmeasuredRepos: ["web-app"],
        })
    ).toContain(
        "Note: no commit at or before the window end was available for web-app; that repository was not measured."
    );
});

test("size reports disclose repositories without a window-end snapshot", () => {
    expect(
        renderSizeReport("md", sizeRows, { unmeasuredRepos: ["api"] })
    ).toContain(
        "Note: no commit at or before the window end was available for api; that repository was not measured."
    );
});

test("populated insight reports preserve the existing tables", () => {
    expect(
        renderHotspotsReport("md", hotspotRows, {
            minFileLines: 50,
            unmeasuredRepos: [],
        })
    ).toBe(renderMarkdown(hotspotsTable(hotspotRows)));
    expect(renderSizeReport("md", sizeRows, { unmeasuredRepos: [] })).toBe(
        renderMarkdown(sizeTable(sizeRows))
    );
    expect(
        renderTimelineReport("md", timelineRows, {
            windowStart: new Date("2025-07-01T00:00:00Z"),
        })
    ).toBe(renderMarkdown(timelineTable(timelineRows)));
    const ownershipOutput = renderOwnershipReport(
        "md",
        {
            ...sharedOwnership,
            busFactor: [
                {
                    repo: "web-app",
                    dir: "src",
                    soleOwnedCount: 1,
                    owners: ["dev-one"],
                },
            ],
        },
        { minFileLines: 50, busFactorThreshold: 0.8 }
    );
    expect(ownershipOutput).toContain(
        "| web-app/src/app.ts | 100 | dev-one | 60% | 2 | - |"
    );
    expect(ownershipOutput).toContain("| web-app | src | 1 | dev-one |");
    expect(ownershipOutput).toContain(
        "ownership credits every surviving line to its single git blame author"
    );
});
