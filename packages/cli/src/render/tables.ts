import { PER_DEV_METRICS } from "../aggregate/metrics";
import type {
    DevPeriodRollup,
    LanguageSize,
    PeriodRollup,
    SizeTrendPoint,
} from "../aggregate/types";
import type { TableCell, TableColumn, TableModel } from "./table-model";

export function churnPeriodTable(rows: PeriodRollup[]): TableModel {
    return {
        columns: [
            { key: "period", label: "Period", align: "left" },
            { key: "commits", label: "Commits", align: "right" },
            { key: "added", label: "Added", align: "right" },
            { key: "deleted", label: "Deleted", align: "right" },
            { key: "net", label: "Net", align: "right" },
            { key: "throughput", label: "Throughput", align: "right" },
            { key: "migrations", label: "Migrations", align: "right" },
        ],
        rows: rows.map((row) => ({
            period: row.period,
            commits: row.commits,
            added: row.added,
            deleted: row.deleted,
            net: row.net,
            throughput: row.throughput,
            migrations: row.migrationsAdded + row.migrationsDeleted,
        })),
    };
}

export function devTable(
    rows: DevPeriodRollup[],
    opts?: { includePeriod?: boolean }
): TableModel {
    const includePeriod = opts?.includePeriod ?? false;
    const metricColumns: TableColumn[] = PER_DEV_METRICS.map((metric) => ({
        key: metric.key,
        label: metric.label,
        align: "right",
        flag: metric.flag,
    }));
    const periodColumn: TableColumn[] = includePeriod
        ? [{ key: "period", label: "Period", align: "left" }]
        : [];
    const columns: TableColumn[] = [
        ...periodColumn,
        { key: "author", label: "Author", align: "left" },
        ...metricColumns,
    ];

    return {
        columns,
        rows: rows.map((row) => {
            const cells: Record<string, TableCell> = {
                author: row.author,
                commits: row.commits,
                added: row.added,
                deleted: row.deleted,
                net: row.net,
                throughput: row.throughput,
                filesTouched: row.filesTouched,
                avgCommitSize: row.avgCommitSize,
                activeDays: row.activeDays,
            };
            if (includePeriod) cells.period = row.period;
            return cells;
        }),
    };
}

function formatLanguages(languages: LanguageSize[]): string {
    return languages
        .map((language) => `${language.language} ${language.code}`)
        .join(", ");
}

export function sizeTable(rows: SizeTrendPoint[]): TableModel {
    return {
        columns: [
            { key: "month", label: "Month", align: "left" },
            { key: "totalCode", label: "Total code", align: "right" },
            {
                key: "totalComplexity",
                label: "Total complexity",
                align: "right",
            },
            { key: "languages", label: "Languages", align: "left" },
        ],
        rows: rows.map((row) => ({
            month: row.month,
            totalCode: row.totalCode,
            totalComplexity: row.totalComplexity,
            languages: formatLanguages(row.languages),
        })),
    };
}
