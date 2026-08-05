import type {
    DevComplexityRollup,
    DevPeriodRollup,
    OwnershipAggregation,
    SyncFloor,
    TicketAggregation,
    TicketCounts,
    TicketCoverage,
    TicketTeamRollup,
} from "../aggregate/types";
import { formatCell } from "./format";
import { renderJson } from "./json";
import { renderMarkdown, type MarkdownLayout } from "./markdown";
import {
    busFactorTable,
    complexityTable,
    devTable,
    ownershipTable,
    pullRequestSizeTable,
    ticketDevTable,
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
export { renderMarkdown, type MarkdownLayout } from "./markdown";
export { renderJson } from "./json";
export {
    busFactorTable,
    churnPeriodTable,
    complexityTable,
    devTable,
    hotspotsTable,
    ownershipTable,
    pullRequestSizeTable,
    sizeTable,
    ticketDevTable,
    timelineTable,
    toPercent,
} from "./tables";
export { writeRendered } from "./output";

export type RenderFormat = "table" | "md" | "json";

const OWNERSHIP_CAVEAT =
    "Note: ownership credits every surviving line to its single git blame author; Co-authored-by trailers are not split, unlike churn attribution.";
const COMPLEXITY_CAVEAT =
    "Note: complexity attribution is approximate — scc measures per-file snapshots, not diffs, so only a file's net monthly complexity change is known; one dev's additions and another's removals inside the same file-month cannot be separated.";
const TICKET_REVERT_CAVEAT =
    'Note: revert matching is approximate — GitHub exposes no revert relationship, so a pull request titled Revert "X" is paired by title with the newest cached pull request titled X in the same repo that already existed when the revert was opened, and the thrash counts against that pull request rather than whoever reverted it.';
const REPORT_SEPARATOR = "\n\n";

export type ContributorsReport = {
    contributors: DevPeriodRollup[];
    complexity: DevComplexityRollup[];
    unattributedComplexity: number;
};

function unattributedComplexityNote(value: number): string {
    return `Note: ${formatCell(value)} net complexity points could not be attributed to a contributor (files changed with no in-window churn from a windowed contributor).`;
}

// The ticket-layer tables carry titles, so the report has to be able to place
// them under its own headings instead of at the default depth.
function modelRenderer(
    format: RenderFormat,
    layout: MarkdownLayout | undefined
): (model: TableModel) => string {
    function render(model: TableModel): string {
        return format === "md"
            ? renderMarkdown(model, layout)
            : renderTable(model);
    }
    return render;
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

export type TicketsReportContext = { window: string; repos: string[] };

// Every format reads scope and coverage off the aggregation, so the prose here
// can never claim something the JSON payload does not also carry.
function ticketCountNote(coverage: TicketCoverage): string {
    const scope = coverage.includeIssues
        ? "Opened and closed count pull requests and issues together, so planning volume and delivery volume share a column; merged counts pull requests only."
        : "Opened, merged and closed count pull requests only — issues are out of scope for this run (tickets.github.includeIssues is off).";
    return `Note: ${scope} A merged pull request never counts again as closed. Reopen counts are a ticket's lifetime total, charged to the window the ticket was opened in. Cycle time and pull request size exclude bot-authored pull requests; the counts do not.`;
}

function syncFloorNote(floors: SyncFloor[]): string {
    const spans = floors
        .map((floor) => `${floor.repo} (${floor.since})`)
        .join(", ");
    return `Note: the ticket cache was synced from a later date than this window starts — ${spans} — so nothing before then is reported, however wide the window reads.`;
}

function withSyncFloorNote(message: string, floors: SyncFloor[]): string {
    if (floors.length === 0) {
        return message;
    }
    return [message, syncFloorNote(floors)].join(REPORT_SEPARATOR);
}

function ticketTeamLine(team: TicketTeamRollup): string {
    return [
        `Team: ${formatCell(team.opened)} opened`,
        `${formatCell(team.merged)} merged`,
        `${formatCell(team.closed)} closed`,
        `${formatCell(team.reopened)} reopened`,
        `${formatCell(team.reverted)} reverted`,
        `cycle time ${formatCell(team.cycleTimeMedianHours)}h median`,
        `PR size ${formatCell(team.pullRequestSizeMedian)} lines median`,
    ].join(" · ");
}

function hasAnyCount(counts: TicketCounts): boolean {
    return (
        counts.opened +
            counts.merged +
            counts.closed +
            counts.reopened +
            counts.reverted >
        0
    );
}

function unattributedTicketsNote(result: TicketAggregation): string {
    const { unattributed, attribution } = result;
    const gaps = [
        `${formatCell(unattributed.opened)} opened`,
        `${formatCell(unattributed.merged)} merged`,
        `${formatCell(unattributed.closed)} closed`,
        `${formatCell(unattributed.reopened)} reopened`,
        `${formatCell(unattributed.reverted)} reverted`,
    ].join(", ");
    return `Note: the team totals carry ticket activity that no per-dev row does — ${gaps}. Under the "${attribution}" attribution mode that actor is unset, a bot, or a login with no author mapping; a reverted count also lands here when the reverted pull request itself credits nobody.`;
}

function unmatchedRevertsNote(count: number): string {
    return `Note: ${formatCell(count)} of those reverting pull request(s) matched no cached pull request title at all, so they could not be charged to any pull request.`;
}

function discardedCycleTimesNote(count: number): string {
    return `Note: ${formatCell(count)} merged pull request(s) report a merge earlier than their own creation and are left out of the cycle-time medians.`;
}

function noCreditedDevsLine(result: TicketAggregation): string {
    return `No per-dev rows: every ticket in this window credits no author under the "${result.attribution}" attribution mode.`;
}

function noTicketsMessage(context: TicketsReportContext): string {
    return `No tickets cached for ${context.window} in ${context.repos.join(", ")} — nothing was opened, merged or closed in this window.`;
}

export function renderTicketsReport(
    format: RenderFormat,
    result: TicketAggregation,
    context: TicketsReportContext,
    layout?: MarkdownLayout
): string {
    if (format === "json") return renderJson(result);
    const { team, unattributed } = result;
    // An empty window is the case most likely to be a cache artefact rather
    // than a fact about the team, so the sync floor has to survive the early
    // return that states it as one.
    if (team.opened === 0 && team.merged === 0 && team.closed === 0) {
        return withSyncFloorNote(
            noTicketsMessage(context),
            result.coverage.lateSyncFloors
        );
    }

    const renderModel = modelRenderer(format, layout);
    const sections = [
        result.devs.length === 0
            ? noCreditedDevsLine(result)
            : renderModel(ticketDevTable(result.devs, result.attribution)),
    ];
    if (result.pullRequestSizes.some((bucket) => bucket.pullRequests > 0)) {
        sections.push(
            renderModel(pullRequestSizeTable(result.pullRequestSizes))
        );
    }
    sections.push(
        ticketTeamLine(team),
        ticketCountNote(result.coverage),
        TICKET_REVERT_CAVEAT
    );
    if (result.coverage.lateSyncFloors.length > 0) {
        sections.push(syncFloorNote(result.coverage.lateSyncFloors));
    }
    if (hasAnyCount(unattributed)) {
        sections.push(unattributedTicketsNote(result));
    }
    if (team.unmatchedReverts > 0) {
        sections.push(unmatchedRevertsNote(team.unmatchedReverts));
    }
    if (team.cycleTimesDiscarded > 0) {
        sections.push(discardedCycleTimesNote(team.cycleTimesDiscarded));
    }
    return sections.join(REPORT_SEPARATOR);
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
