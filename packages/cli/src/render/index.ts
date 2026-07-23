import type {
    DevComplexityRollup,
    DevPeriodRollup,
    OwnershipAggregation,
} from "../aggregate/types";
import { formatCell } from "./format";
import { renderJson } from "./json";
import { renderMarkdown } from "./markdown";
import {
    busFactorTable,
    complexityTable,
    devTable,
    ownershipTable,
} from "./tables";
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
    complexityTable,
    devTable,
    hotspotsTable,
    ownershipTable,
    sizeTable,
    timelineTable,
} from "./tables";
export { writeRendered } from "./output";

export type RenderFormat = "table" | "md" | "json";

const OWNERSHIP_CAVEAT =
    "Note: ownership credits every surviving line to its single git blame author; Co-authored-by trailers are not split, unlike churn attribution.";
const COMPLEXITY_CAVEAT =
    "Note: complexity attribution is approximate — scc measures per-file snapshots, not diffs, so only a file's net monthly complexity change is known; one dev's additions and another's removals inside the same file-month cannot be separated.";
const REPORT_SEPARATOR = "\n\n";

export type ContributorsReport = {
    contributors: DevPeriodRollup[];
    complexity: DevComplexityRollup[];
    unattributedComplexity: number;
};

function unattributedComplexityNote(value: number): string {
    return `Note: ${formatCell(value)} net complexity points could not be attributed to a contributor (files changed with no in-window churn from a windowed contributor).`;
}

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

export function renderContributorsReport(
    format: RenderFormat,
    result: ContributorsReport
): string {
    if (format === "json") return renderJson(result);
    const renderModel = format === "md" ? renderMarkdown : renderTable;
    const sections = [
        renderModel(devTable(result.contributors, { includePeriod: false })),
        renderModel(complexityTable(result.complexity)),
        COMPLEXITY_CAVEAT,
    ];
    if (result.unattributedComplexity !== 0) {
        sections.push(
            unattributedComplexityNote(result.unattributedComplexity)
        );
    }
    return sections.join(REPORT_SEPARATOR);
}
