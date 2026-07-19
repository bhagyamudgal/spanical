import { expect, test } from "bun:test";
import type {
    DevPeriodRollup,
    PeriodRollup,
    SizeTrendPoint,
} from "../aggregate/types";
import { formatCell } from "./format";
import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import { churnPeriodTable, devTable, sizeTable } from "./tables";
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
