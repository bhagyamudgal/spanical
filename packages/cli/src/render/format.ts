import type { ReadFlag } from "../aggregate/metrics";
import type { TableCell, TableColumn } from "./table-model";

const integerFormatter = new Intl.NumberFormat("en-US");
const decimalFormatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
});

const NULL_CELL = "-";

export function formatCell(value: TableCell): string {
    if (value === null) return NULL_CELL;
    if (typeof value === "string") return value;
    if (Number.isInteger(value)) return integerFormatter.format(value);
    return decimalFormatter.format(value);
}

export const FLAG_MARKERS: Record<ReadFlag, string> = {
    signal: "(signal)",
    context: "(context)",
    trap: "(volume)",
};

export const FLAG_LEGEND =
    "flags: (signal) safe to read per-dev · (context) needs interpretation · (volume) narrative only, not a ranking";

export function headLabel(column: TableColumn): string {
    if (!column.flag) return column.label;
    return `${column.label} ${FLAG_MARKERS[column.flag]}`;
}

export function hasFlaggedColumn(columns: TableColumn[]): boolean {
    return columns.some((column) => column.flag !== undefined);
}
