import Table from "cli-table3";
import pc from "picocolors";
import { FLAG_LEGEND, formatCell, hasFlaggedColumn, headLabel } from "./format";
import type { TableModel } from "./table-model";

export function renderTable(model: TableModel): string {
    const head = model.columns.map((column) => pc.bold(headLabel(column)));
    const colAligns = model.columns.map((column) =>
        column.align === "right" ? "right" : "left"
    );

    const table = new Table({ head, colAligns });
    for (const row of model.rows) {
        table.push(
            model.columns.map((column) => formatCell(row[column.key] ?? null))
        );
    }

    const parts: string[] = [];
    if (model.title) parts.push(model.title);
    parts.push(table.toString());
    if (hasFlaggedColumn(model.columns)) parts.push(pc.dim(FLAG_LEGEND));
    return parts.join("\n");
}
