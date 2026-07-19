import { FLAG_LEGEND, formatCell, hasFlaggedColumn, headLabel } from "./format";
import type { TableColumn, TableModel } from "./table-model";

function separatorCell(column: TableColumn): string {
    return column.align === "right" ? "---:" : "---";
}

function tableRow(cells: string[]): string {
    return `| ${cells.join(" | ")} |`;
}

export function renderMarkdown(model: TableModel): string {
    const lines: string[] = [];
    if (model.title) {
        lines.push(`## ${model.title}`);
        lines.push("");
    }

    lines.push(tableRow(model.columns.map(headLabel)));
    lines.push(tableRow(model.columns.map(separatorCell)));
    for (const row of model.rows) {
        lines.push(
            tableRow(
                model.columns.map((column) =>
                    formatCell(row[column.key] ?? null)
                )
            )
        );
    }

    if (hasFlaggedColumn(model.columns)) {
        lines.push("");
        lines.push(`_${FLAG_LEGEND}_`);
    }

    return lines.join("\n");
}
