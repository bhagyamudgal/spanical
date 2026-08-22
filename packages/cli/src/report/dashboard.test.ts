import { expect, test } from "bun:test";
import type {
    CodebaseSummary,
    DevPeriodRollup,
    HotspotRow,
    PeriodRollup,
    SizeTrendPoint,
} from "../aggregate/types";
import { buildDashboardHtml } from "./dashboard";

const SUMMARY: CodebaseSummary = {
    netGrowth: 28126,
    totalChurn: 30776,
    commits: 79,
    activeDevs: 2,
    busiestPeriod: "2026-07",
    growthEfficiency: 0.93,
    migrations: { added: 0, deleted: 0, throughput: 0 },
    totalSizeNow: 30000,
};

const PER_PERIOD: PeriodRollup[] = [
    {
        period: "2026-07",
        commits: 50,
        added: 13751,
        deleted: 345,
        net: 13406,
        throughput: 14096,
        migrationsAdded: 0,
        migrationsDeleted: 0,
    },
];

const PER_DEV: DevPeriodRollup[] = [
    {
        period: "window",
        authorId: 1,
        author: "dev-one",
        commits: 78,
        added: 29245,
        deleted: 1119,
        net: 28126,
        throughput: 30364,
        filesTouched: 400,
        avgCommitSize: 389,
        activeDays: 20,
        reworkLines: 1000,
    },
];

const SIZE_TREND: SizeTrendPoint[] = [
    {
        month: "2026-07",
        totalCode: 28000,
        totalComplexity: 1200,
        languages: [{ language: "TypeScript", code: 27000 }],
    },
];

const HOTSPOTS: HotspotRow[] = [
    {
        repo: "web-app",
        path: "src/render/index.ts",
        changeFrequency: 9,
        complexity: 71,
        freqNorm: 1,
        cxNorm: 1,
        score: 0.8,
        ownerCount: 1,
    },
];

test("dashboard embeds every chart, the vendored bundle, and the data object", () => {
    const html = buildDashboardHtml({
        windowLabel: "last 12m",
        summary: SUMMARY,
        perPeriod: PER_PERIOD,
        perDev: PER_DEV,
        sizeTrend: SIZE_TREND,
        hotspots: HOTSPOTS,
    });

    expect(html.match(/<canvas /g)).toHaveLength(6);
    expect(html).toContain("Chart.js v4");
    expect(html).toContain("const DATA = ");
    expect(html).toContain("dev-one");
    expect(html).toContain("Net growth per period");
});

test("dashboard makes no external requests and survives script-breaking input", () => {
    const hostileAuthor = "</script><script>alert(1)</script>";
    const html = buildDashboardHtml({
        windowLabel: "last 12m",
        summary: SUMMARY,
        perPeriod: PER_PERIOD,
        perDev: [
            {
                ...PER_DEV[0]!,
                author: hostileAuthor,
            },
        ],
        sizeTrend: SIZE_TREND,
        hotspots: [],
    });

    expect(html.match(/<script>/g)).toHaveLength(2);
    expect(html).not.toContain("</script>alert");
    // The escaped author name still round-trips for the chart.
    expect(html).toContain("\\u003c/script");
});
