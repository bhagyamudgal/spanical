import type { ReadFlag } from "../aggregate/metrics";

export type ColumnAlign = "left" | "right";

export type TableColumn = {
    key: string;
    label: string;
    align?: ColumnAlign;
    flag?: ReadFlag;
};

export type TableCell = string | number | null;

export type TableModel = {
    title?: string;
    columns: TableColumn[];
    rows: Record<string, TableCell>[];
};
