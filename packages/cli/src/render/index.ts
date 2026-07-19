import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import type { TableModel } from "./table-model";
import { renderTable } from "./terminal";

export type {
    ColumnAlign,
    TableCell,
    TableColumn,
    TableModel,
} from "./table-model";
export {
    FLAG_LEGEND,
    FLAG_MARKERS,
    formatCell,
    hasFlaggedColumn,
    headLabel,
} from "./format";
export { renderTable } from "./terminal";
export { renderMarkdown } from "./markdown";
export { renderJson } from "./json";
export { churnPeriodTable, devTable, sizeTable } from "./tables";
export { writeRendered } from "./output";

export type RenderFormat = "table" | "md" | "json";

export function renderData(
    format: RenderFormat,
    model: TableModel,
    data: unknown
): string {
    if (format === "json") return renderJson(data);
    if (format === "table") return renderTable(model);
    return renderMarkdown(model);
}
