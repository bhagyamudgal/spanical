import { PER_DEV_METRICS } from "../aggregate/metrics";
import type {
    BusFactorRow,
    DevPeriodRollup,
    HotspotRow,
    LanguageSize,
    OwnershipRow,
    PeriodRollup,
    SizeTrendPoint,
} from "../aggregate/types";
import type { TableCell, TableColumn, TableModel } from "./table-model";

const PERCENT_SCALE = 100;
const SOLE_OWNED_YES = "yes";
const SOLE_OWNED_NO = "-";
const OWNERS_SEPARATOR = ", ";
const SCORE_DECIMALS = 3;

function toPercent(share: number): string {
    return `${Math.round(share * PERCENT_SCALE)}%`;
}

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

export function ownershipTable(rows: OwnershipRow[]): TableModel {
    return {
        columns: [
            { key: "path", label: "Path", align: "left" },
            { key: "lines", label: "Lines", align: "right" },
            { key: "primaryOwner", label: "Primary owner", align: "left" },
            { key: "ownership", label: "Ownership %", align: "right" },
            { key: "owners", label: "#Owners", align: "right" },
            { key: "soleOwned", label: "Sole-owned", align: "left" },
        ],
        rows: rows.map((row) => ({
            path: `${row.repo}/${row.path}`,
            lines: row.totalLines,
            primaryOwner: row.primaryOwner ?? SOLE_OWNED_NO,
            ownership: toPercent(row.primaryShare),
            owners: row.ownerCount,
            soleOwned: row.isSoleOwned ? SOLE_OWNED_YES : SOLE_OWNED_NO,
        })),
    };
}

export function busFactorTable(rows: BusFactorRow[]): TableModel {
    return {
        columns: [
            { key: "repo", label: "Repo", align: "left" },
            { key: "dir", label: "Directory", align: "left" },
            { key: "soleOwned", label: "Sole-owned files", align: "right" },
            { key: "owners", label: "Owner(s)", align: "left" },
        ],
        rows: rows.map((row) => ({
            repo: row.repo,
            dir: row.dir,
            soleOwned: row.soleOwnedCount,
            owners: row.owners.join(OWNERS_SEPARATOR),
        })),
    };
}

export function hotspotsTable(rows: HotspotRow[]): TableModel {
    return {
        columns: [
            { key: "path", label: "Path", align: "left" },
            { key: "changeFrequency", label: "Change freq", align: "right" },
            { key: "complexity", label: "Complexity", align: "right" },
            { key: "score", label: "Score", align: "right" },
            { key: "owners", label: "#Owners", align: "right" },
        ],
        rows: rows.map((row) => ({
            path: `${row.repo}/${row.path}`,
            changeFrequency: row.changeFrequency,
            complexity: row.complexity,
            score: row.score.toFixed(SCORE_DECIMALS),
            owners: row.ownerCount,
        })),
    };
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
