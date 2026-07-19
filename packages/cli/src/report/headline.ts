import type {
    CodebaseSummary,
    HotspotRow,
    OwnershipAggregation,
} from "../aggregate/types";
import { formatCell } from "../render";
import type { Granularity } from "../window";
import { formatSummaryBlock } from "./summary-block";

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
    busFactorThreshold: number;
};

function hotspotLine(row: HotspotRow): string {
    return `${HOTSPOT_INDENT}${row.repo}/${row.path}  churn ${formatCell(row.changeFrequency)} · cx ${formatCell(row.complexity)} · owners ${formatCell(row.ownerCount)}`;
}

function hotspotsShortlist(hotspots: HotspotRow[]): string {
    const lines = hotspots
        .slice(0, TOP_HOTSPOTS_IN_HEADLINE)
        .map(hotspotLine);
    return [HOTSPOTS_HEADING, ...lines].join("\n");
}

function busFactorLine(
    ownership: OwnershipAggregation,
    busFactorThreshold: number
): string {
    const soleOwned = ownership.files.filter((file) => file.isSoleOwned).length;
    const dirs = ownership.busFactor.length;
    const percent = Math.round(busFactorThreshold * PERCENT_SCALE);
    return `Bus-factor warnings: ${soleOwned} files owned > ${percent}% by a single dev in ${dirs} dirs`;
}

export function formatHeadline(input: HeadlineInput): string {
    return [
        formatSummaryBlock(input.summary, input.granularity),
        hotspotsShortlist(input.hotspots),
        busFactorLine(input.ownership, input.busFactorThreshold),
    ].join(HEADLINE_GAP);
}
