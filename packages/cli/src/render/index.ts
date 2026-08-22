import { hasTicketActivity } from "../aggregate/tickets";
import type {
    DevComplexityRollup,
    DevPeriodRollup,
    ExcludedReviews,
    HotspotRow,
    OwnershipAggregation,
    ReviewAggregation,
    ReviewCoverage,
    ReviewTeamRollup,
    SyncFloor,
    SizeTrendPoint,
    TicketAggregation,
    TicketCounts,
    TicketCoverage,
    TicketTeamRollup,
    TimelinePeriod,
} from "../aggregate/types";
import { formatCell } from "./format";
import { renderJson } from "./json";
import { renderMarkdown, type MarkdownLayout } from "./markdown";
import {
    busFactorTable,
    complexityTable,
    devTable,
    formatLatencyBasis,
    hotspotsTable,
    ownershipTable,
    pullRequestSizeTable,
    reviewDevTable,
    sizeTable,
    ticketDevTable,
    toPercent,
    timelineTable,
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
    formatLatencyBasis,
    hotspotsTable,
    ownershipTable,
    pullRequestSizeTable,
    reviewDevTable,
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

function reworkCaveat(reworkWindowDays: number): string {
    return `Note: rework counts lines deleted within ${reworkWindowDays} days of the commit that wrote them, charged to the original author whether the deleter was that same dev or someone else. Like ownership, each line credits its single git blame author; Co-authored-by trailers are not split, unlike churn attribution. Some iteration is healthy; sustained rework is the thrash signal, read as context, never in isolation. Lines deleted by a commit that also renamed their file are not attributed — the diff then reads as new-file additions.`;
}

function incompleteReworkNote(repos: string[]): string {
    return `Note: rework capture failed for part of ${repos.join(", ")}, so those repositories' rework lines are undercounts, not verified zeros.`;
}

const TICKET_REVERT_CAVEAT =
    'Note: revert matching is approximate — GitHub exposes no revert relationship, so a pull request titled Revert "X" is paired by title with the most recently merged cached pull request titled X in the same repo that had already merged when the revert was opened, and the thrash counts against that pull request rather than whoever reverted it.';
const REVIEW_COUNT_CAVEAT =
    "Note: reviews given counts the distinct pull requests a reviewer submitted a review on, so several reviews on one pull request read as one, and a review on the reviewer's own pull request never counts. A review still pending counts nowhere until it is submitted. Bot reviewers stay in the team review count and in review coverage but never move a latency median.";
const REVIEW_LATENCY_CAVEAT =
    'Note: review latency takes one sample per request cycle — the first review submitted after a review request, and again after each re-request. A "requested" sample is measured from the review request; a "created" sample from the pull request opening, because no review request for it was cached. The two clocks measure different things, so read a median against its basis mix rather than on its own.';
const REVIEW_COVERAGE_CAVEAT =
    "Note: review coverage is measured over the pull requests merged in this window — a merged pull request's review history is final, while an open one can still pick up a review tomorrow — and counts one as covered when anyone other than its own author reviewed it, whenever that review landed.";
const NO_LATENCY_SAMPLES = "no samples";
const REPORT_SEPARATOR = "\n\n";
const TEAM_SEPARATOR = " · ";

export type ContributorsReport = {
    contributors: DevPeriodRollup[];
    complexity: DevComplexityRollup[];
    unattributedComplexity: number;
    reworkWindowDays: number;
    incompleteReworkRepos: string[];
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
    data: unknown,
    emptyMessage?: string
): string {
    if (format === "json") return renderJson(data);
    if (model.rows.length === 0 && emptyMessage !== undefined) {
        return emptyMessage;
    }
    if (format === "table") return renderTable(model);
    return renderMarkdown(model);
}

export type HotspotsReportContext = {
    minFileLines: number;
    unmeasuredRepos: string[];
};

export function formatUnmeasuredReposNote(repos: string[]): string | null {
    if (repos.length === 0) {
        return null;
    }
    return `Note: no commit at or before the window end was available for ${repos.join(", ")}; ${repos.length === 1 ? "that repository was" : "those repositories were"} not measured.`;
}

export function formatEmptyHotspots(context: HotspotsReportContext): string {
    const sections = [
        `No hotspots: no eligible non-binary, non-migration file both changed in the selected window and had at least ${formatCell(context.minFileLines)} code lines in its window-end SCC snapshot.`,
    ];
    const missingNote = formatUnmeasuredReposNote(context.unmeasuredRepos);
    if (missingNote !== null) {
        sections.push(missingNote);
    }
    return sections.join(REPORT_SEPARATOR);
}

export function renderHotspotsReport(
    format: RenderFormat,
    rows: HotspotRow[],
    context: HotspotsReportContext
): string {
    if (format === "json") return renderJson(rows);
    const content =
        rows.length === 0
            ? formatEmptyHotspots(context)
            : modelRenderer(format, undefined)(hotspotsTable(rows));
    const sections = [content];
    if (rows.length > 0) {
        const missingNote = formatUnmeasuredReposNote(context.unmeasuredRepos);
        if (missingNote !== null) {
            sections.push(missingNote);
        }
    }
    return sections.join(REPORT_SEPARATOR);
}

export function renderSizeReport(
    format: RenderFormat,
    rows: SizeTrendPoint[],
    context: { unmeasuredRepos: string[] }
): string {
    if (format === "json") {
        return renderJson(rows);
    }
    const content = renderData(
        format,
        sizeTable(rows),
        rows,
        "No size trend: no monthly boundary SCC snapshot data was available for the selected repositories."
    );
    const missingNote = formatUnmeasuredReposNote(context.unmeasuredRepos);
    return missingNote === null
        ? content
        : [content, missingNote].join(REPORT_SEPARATOR);
}

export function renderTimelineReport(
    format: RenderFormat,
    rows: TimelinePeriod[],
    context: { windowStart: Date | null }
): string {
    const emptyMessage =
        context.windowStart === null
            ? "No timeline periods: an open-start history window has no bounded periods to plot."
            : "No timeline periods were available for the selected window.";
    return renderData(format, timelineTable(rows), rows, emptyMessage);
}

export type OwnershipReportContext = {
    minFileLines: number;
    busFactorThreshold: number;
};

export function renderOwnershipReport(
    format: RenderFormat,
    result: OwnershipAggregation,
    context: OwnershipReportContext
): string {
    if (format === "json") return renderJson(result);
    const renderModel = format === "md" ? renderMarkdown : renderTable;
    const sections = [
        result.files.length === 0
            ? `No ownership data: no surviving blame rows were available for files with at least ${formatCell(context.minFileLines)} code lines.`
            : renderModel(ownershipTable(result.files)),
    ];
    if (result.files.length > 0) {
        sections.push(
            result.busFactor.length === 0
                ? `No bus-factor warnings: no file met the ${toPercent(context.busFactorThreshold)} sole-ownership threshold.`
                : renderModel(busFactorTable(result.busFactor))
        );
    }
    sections.push(OWNERSHIP_CAVEAT);
    return sections.join(REPORT_SEPARATOR);
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

// One list, so a sixth count column cannot reach the team line and the
// unattributed note in disagreement about what the window holds.
function formatTicketCounts(counts: TicketCounts, separator: string): string {
    return [
        `${formatCell(counts.opened)} opened`,
        `${formatCell(counts.merged)} merged`,
        `${formatCell(counts.closed)} closed`,
        `${formatCell(counts.reopened)} reopened`,
        `${formatCell(counts.reverted)} reverted`,
    ].join(separator);
}

function ticketTeamLine(team: TicketTeamRollup): string {
    return [
        `Team: ${formatTicketCounts(team, TEAM_SEPARATOR)}`,
        `cycle time ${formatCell(team.cycleTimeMedianHours)}h median`,
        `PR size ${formatCell(team.pullRequestSizeMedian)} lines median`,
    ].join(TEAM_SEPARATOR);
}

function unattributedTicketsNote(result: TicketAggregation): string {
    const { unattributed, attribution } = result;
    const gaps = formatTicketCounts(unattributed, ", ");
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

// The trigger is an empty window, not an empty cache, so the message leads with
// the window: a fully synced repo with a quiet month must not read as a failed
// sync. A genuine coverage gap is the sync-floor note's job.
function noTicketsMessage(context: TicketsReportContext): string {
    return `No ticket activity in ${context.window} for ${context.repos.join(", ")} — nothing was opened, merged or closed.`;
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
    if (hasTicketActivity(unattributed)) {
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

export type ReviewsReportContext = { window: string; repos: string[] };

function reviewTeamLine(team: ReviewTeamRollup): string {
    return [
        `Team: ${formatCell(team.reviewsGiven)} reviews given`,
        `review latency ${formatCell(team.latencyMedianHours)}h median`,
        `latency basis ${formatLatencyBasis(team) ?? NO_LATENCY_SAMPLES}`,
    ].join(" · ");
}

function unmergedClause(unmerged: number): string {
    if (unmerged === 0) {
        return "";
    }
    return ` ${formatCell(unmerged)} further pull request(s) opened in this window have not merged and sit outside coverage entirely.`;
}

function reviewCoverageLine(coverage: ReviewCoverage): string {
    const unmerged = unmergedClause(coverage.pullRequestsUnmerged);
    if (coverage.share === null) {
        return `Review coverage: no pull request merged in this window, so coverage has nothing to measure.${unmerged}`;
    }
    return `Review coverage: ${formatCell(coverage.pullRequestsReviewed)} of ${formatCell(coverage.pullRequestsMerged)} merged pull request(s) carry a review (${toPercent(coverage.share)}).${unmerged}`;
}

function discardedLatencyNote(count: number): string {
    return `Note: ${formatCell(count)} review(s) report a submission earlier than the opening of the pull request they are on and are left out of the latency medians.`;
}

function unattributedReviewsNote(
    unattributed: ReviewAggregation["unattributed"]
): string {
    return `Note: the team totals carry review activity that no per-dev row does — ${formatCell(unattributed.reviewsGiven)} review(s) given and ${formatCell(unattributed.latencySamples)} latency sample(s). The reviewer was a bot, a deleted account, or a GitHub login with no author mapping.`;
}

// Every message about what was counted reads off the raw counts, never off
// reviewsGiven: that number is already net of self-reviews and pending reviews,
// so reporting it as "nothing was submitted" would send a reader to check their
// token when what they actually need is the exclusion rule.
function excludedReviewsClause(excluded: ExcludedReviews): string {
    const parts = [
        excluded.selfReviews > 0
            ? `${formatCell(excluded.selfReviews)} self-review(s) submitted in this window`
            : null,
        excluded.pendingReviews > 0
            ? `${formatCell(excluded.pendingReviews)} cached review(s) still pending`
            : null,
    ].filter((part) => part !== null);
    if (parts.length === 0) {
        return "";
    }
    return ` ${parts.join(" and ")} count nowhere by definition.`;
}

function noCreditedReviewersLine(
    team: ReviewTeamRollup,
    excluded: ExcludedReviews
): string {
    if (team.reviewsGiven === 0) {
        return `No per-dev rows: no review counted in this window.${excludedReviewsClause(excluded)}`;
    }
    return "No per-dev rows: every review in this window came from a bot, a deleted account, or a GitHub login with no author mapping.";
}

function noReviewsMessage(
    context: ReviewsReportContext,
    excluded: ExcludedReviews
): string {
    return `No reviews cached for ${context.window} in ${context.repos.join(", ")} — no pull request was merged in this window and no review counted in it.${excludedReviewsClause(excluded)}`;
}

export function renderReviewsReport(
    format: RenderFormat,
    result: ReviewAggregation,
    context: ReviewsReportContext,
    layout?: MarkdownLayout
): string {
    if (format === "json") return renderJson(result);
    const { team, coverage, excluded, unattributed } = result;
    // An empty window is the case most likely to be a cache artefact rather
    // than a fact about the team, so the sync floor has to survive the early
    // return that states it as one.
    if (team.reviewsGiven === 0 && coverage.pullRequestsMerged === 0) {
        return withSyncFloorNote(
            noReviewsMessage(context, excluded),
            result.lateSyncFloors
        );
    }

    const renderModel = modelRenderer(format, layout);
    const sections = [
        result.devs.length === 0
            ? noCreditedReviewersLine(team, excluded)
            : renderModel(reviewDevTable(result.devs)),
        reviewTeamLine(team),
        reviewCoverageLine(coverage),
        REVIEW_COUNT_CAVEAT,
        REVIEW_LATENCY_CAVEAT,
        REVIEW_COVERAGE_CAVEAT,
    ];
    if (result.lateSyncFloors.length > 0) {
        sections.push(syncFloorNote(result.lateSyncFloors));
    }
    if (unattributed.reviewsGiven > 0 || unattributed.latencySamples > 0) {
        sections.push(unattributedReviewsNote(unattributed));
    }
    if (team.latencySamplesDiscarded > 0) {
        sections.push(discardedLatencyNote(team.latencySamplesDiscarded));
    }
    // A reviewer whose whole window was self-reviews and pending reviews is
    // absent from every row above, so the page has to say they were seen.
    const excludedClause = excludedReviewsClause(excluded);
    if (excludedClause.length > 0) {
        sections.push(`Note:${excludedClause}`);
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
        reworkCaveat(result.reworkWindowDays),
    ];
    if (result.incompleteReworkRepos.length > 0) {
        sections.push(incompleteReworkNote(result.incompleteReworkRepos));
    }
    if (result.unattributedComplexity !== 0) {
        sections.push(
            unattributedComplexityNote(result.unattributedComplexity)
        );
    }
    return sections.join(REPORT_SEPARATOR);
}
