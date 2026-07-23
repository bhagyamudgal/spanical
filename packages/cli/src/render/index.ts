import type { OwnershipAggregation } from "../aggregate/types";
import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import { busFactorTable, ownershipTable } from "./tables";
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
export {
    busFactorTable,
    churnPeriodTable,
    devTable,
    ownershipTable,
    sizeTable,
} from "./tables";
export { writeRendered } from "./output";

export type RenderFormat = "table" | "md" | "json";

const OWNERSHIP_CAVEAT =
    "Note: ownership credits every surviving line to its single git blame author; Co-authored-by trailers are not split, unlike churn attribution.";
const REPORT_SEPARATOR = "\n\n";

export function renderData(
    format: RenderFormat,
    model: TableModel,
    data: unknown
): string {
    if (format === "json") return renderJson(data);
    if (format === "table") return renderTable(model);
    return renderMarkdown(model);
}

export function renderOwnershipReport(
    format: RenderFormat,
    result: OwnershipAggregation
): string {
    if (format === "json") return renderJson(result);
    const renderModel = format === "md" ? renderMarkdown : renderTable;
    return [
        renderModel(ownershipTable(result.files)),
        renderModel(busFactorTable(result.busFactor)),
        OWNERSHIP_CAVEAT,
    ].join(REPORT_SEPARATOR);
}
