import type {
    CodebaseSummary,
    HotspotRow,
    OwnershipAggregation,
} from "../aggregate/types";
import {
    formatCell,
    formatEmptyHotspots,
    formatUnmeasuredReposNote,
    type HotspotsReportContext,
} from "../render";
import type { Granularity } from "../window";
import { formatSummaryBlock } from "./summary-block";
import type { SizeCoverage } from "./summary-block";

const TOP_HOTSPOTS_IN_HEADLINE = 5;
const PERCENT_SCALE = 100;
const HEADLINE_GAP = "\n\n";
const HOTSPOT_INDENT = "  ";
const HOTSPOTS_HEADING = "Top hotspots (refactor shortlist)";

export type HeadlineInput = {
    summary: CodebaseSummary;
    granularity: Granularity;
    hotspots: HotspotRow[];
    ownership: OwnershipAggregation;
    minFileLines: number;
    unmeasuredRepos: string[];
    repoCount: number;
    busFactorThreshold: number;
};

function hotspotLine(row: HotspotRow): string {
    return `${HOTSPOT_INDENT}${row.repo}/${row.path}  churn ${formatCell(row.changeFrequency)} · cx ${formatCell(row.complexity)} · owners ${formatCell(row.ownerCount)}`;
}

function hotspotsShortlist(
    hotspots: HotspotRow[],
    context: HotspotsReportContext
): string {
    if (hotspots.length === 0) {
        return formatEmptyHotspots(context);
    }
    const lines = hotspots.slice(0, TOP_HOTSPOTS_IN_HEADLINE).map(hotspotLine);
    const sections = [[HOTSPOTS_HEADING, ...lines].join("\n")];
    const missingNote = formatUnmeasuredReposNote(context.unmeasuredRepos);
    if (missingNote !== null) {
        sections.push(missingNote);
    }
    return sections.join(HEADLINE_GAP);
}

function sizeCoverage(input: HeadlineInput): SizeCoverage {
    if (input.unmeasuredRepos.length === 0) {
        return "complete";
    }
    if (input.unmeasuredRepos.length === input.repoCount) {
        return "unavailable";
    }
    return "partial";
}

function busFactorLine(
    ownership: OwnershipAggregation,
    busFactorThreshold: number
): string {
    const soleOwned = ownership.files.filter((file) => file.isSoleOwned).length;
    const dirs = ownership.busFactor.length;
    const percent = Math.round(busFactorThreshold * PERCENT_SCALE);
    const fileWord = soleOwned === 1 ? "file" : "files";
    const dirWord = dirs === 1 ? "dir" : "dirs";
    return `Bus-factor warnings: ${soleOwned} ${fileWord} owned > ${percent}% by a single dev in ${dirs} ${dirWord}`;
}

export function formatHeadline(input: HeadlineInput): string {
    return [
        formatSummaryBlock(
            input.summary,
            input.granularity,
            sizeCoverage(input)
        ),
        hotspotsShortlist(input.hotspots, {
            minFileLines: input.minFileLines,
            unmeasuredRepos: input.unmeasuredRepos,
        }),
        busFactorLine(input.ownership, input.busFactorThreshold),
    ].join(HEADLINE_GAP);
}
