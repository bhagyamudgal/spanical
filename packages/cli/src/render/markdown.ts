import { FLAG_LEGEND, formatCell, hasFlaggedColumn, headLabel } from "./format";
import type { TableColumn, TableModel } from "./table-model";

const DEFAULT_TITLE_LEVEL = 2;

// A table title is a heading, so a caller nesting the table inside a document
// of its own has to be able to say how deep it sits.
export type MarkdownLayout = { titleLevel: number };

function separatorCell(column: TableColumn): string {
    return column.align === "right" ? "---:" : "---";
}

function tableRow(cells: string[]): string {
    return `| ${cells.join(" | ")} |`;
}

export function renderMarkdown(
    model: TableModel,
    layout?: MarkdownLayout
): string {
    const lines: string[] = [];
    if (model.title) {
        const level = layout?.titleLevel ?? DEFAULT_TITLE_LEVEL;
        lines.push(`${"#".repeat(level)} ${model.title}`);
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
