import type { CodebaseSummary } from "../aggregate/types";
import { formatCell } from "../render";
import type { Granularity } from "../window";

const GRANULARITY_NOUN: Record<Granularity, string> = {
    week: "week",
    month: "month",
    quarter: "quarter",
};

const INDENT = "  ";
const LABEL_GAP = "  ";
const COLUMN_GAP = "    ";
const NOT_AVAILABLE = "n/a";

type Pair = { label: string; value: string };
type Row = { left: Pair; right: Pair };

function signedLoc(value: number): string {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${formatCell(Math.abs(value))} LOC`;
}

export function formatSummaryBlock(
    summary: CodebaseSummary,
    granularity: Granularity
): string {
    const rows: Row[] = [
        {
            left: { label: "Net growth", value: signedLoc(summary.netGrowth) },
            right: {
                label: "Total now",
                value: `${formatCell(summary.totalSizeNow)} LOC`,
            },
        },
        {
            left: {
                label: "Throughput churn",
                value: `${formatCell(summary.totalChurn)} lines`,
            },
            right: {
                label: "Commits",
                value: `${formatCell(summary.commits)} (no-merge)`,
            },
        },
        {
            left: {
                label: "Active devs",
                value: formatCell(summary.activeDevs),
            },
            right: {
                label: `Busiest ${GRANULARITY_NOUN[granularity]}`,
                value: summary.busiestPeriod ?? NOT_AVAILABLE,
            },
        },
    ];

    const leftLabelWidth = Math.max(
        ...rows.map((row) => row.left.label.length)
    );
    const leftValueWidth = Math.max(
        ...rows.map((row) => row.left.value.length)
    );
    const rightLabelWidth = Math.max(
        ...rows.map((row) => row.right.label.length)
    );

    return rows
        .map((row) => {
            const left = `${row.left.label.padEnd(leftLabelWidth)}${LABEL_GAP}${row.left.value.padEnd(leftValueWidth)}`;
            const right = `${row.right.label.padEnd(rightLabelWidth)}${LABEL_GAP}${row.right.value}`;
            return `${INDENT}${left}${COLUMN_GAP}${right}`;
        })
        .join("\n");
}
