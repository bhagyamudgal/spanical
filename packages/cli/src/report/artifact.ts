import type {
    ComplexityAttribution,
    DevPeriodRollup,
    FullAggregation,
    HotspotRow,
    MigrationChurn,
    OwnershipAggregation,
    RepoAggregation,
    TimelinePeriod,
} from "../aggregate/types";
import type { ResolvedRun } from "../cli/resolve-run";
import {
    churnPeriodTable,
    formatCell,
    hotspotsTable,
    renderContributorsReport,
    renderMarkdown,
    renderOwnershipReport,
    sizeTable,
    timelineTable,
} from "../render";
import type { Granularity } from "../window";
import { formatHeadline } from "./headline";
import { formatSummaryBlock } from "./summary-block";

const SECTION_GAP = "\n\n";

export type PerRepoInsight = {
    repo: string;
    aggregation: RepoAggregation;
    contributors: DevPeriodRollup[];
    hotspots: HotspotRow[];
    ownership: OwnershipAggregation;
    complexity: ComplexityAttribution;
    timeline: TimelinePeriod[];
};

export type ReportArtifactInput = {
    full: FullAggregation;
    contributors: DevPeriodRollup[];
    hotspots: HotspotRow[];
    ownership: OwnershipAggregation;
    complexity: ComplexityAttribution;
    timeline: TimelinePeriod[];
    perRepoInsights: PerRepoInsight[];
    busFactorThreshold: number;
    run: ResolvedRun;
};

function fencedBlock(content: string): string {
    return ["```", content, "```"].join("\n");
}

function migrationsLine(migrations: MigrationChurn): string {
    return `Migrations churn: +${formatCell(migrations.added)} / -${formatCell(migrations.deleted)} (${formatCell(migrations.throughput)} lines, tracked separately from main churn)`;
}

function contributorsBlock(
    contributors: DevPeriodRollup[],
    complexity: ComplexityAttribution
): string {
    return renderContributorsReport("md", {
        contributors,
        complexity: complexity.devs,
        unattributedComplexity: complexity.unattributed,
    });
}

function repoAppendixSection(
    insight: PerRepoInsight,
    granularity: Granularity
): string {
    return [
        `### ${insight.repo}`,
        fencedBlock(
            formatSummaryBlock(insight.aggregation.summary, granularity)
        ),
        `#### Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(insight.aggregation.perPeriod))}`,
        `#### Hotspots${SECTION_GAP}${renderMarkdown(hotspotsTable(insight.hotspots))}`,
        `#### Ownership & bus-factor${SECTION_GAP}${renderOwnershipReport("md", insight.ownership)}`,
        `#### Timeline${SECTION_GAP}${renderMarkdown(timelineTable(insight.timeline))}`,
        `#### Contributors${SECTION_GAP}${contributorsBlock(insight.contributors, insight.complexity)}`,
    ].join(SECTION_GAP);
}

export function buildReportArtifact(input: ReportArtifactInput): string {
    const { full, contributors, run } = input;
    const { granularity } = run.window;
    const { combined } = full;

    const appendix = input.perRepoInsights
        .map((insight) => repoAppendixSection(insight, granularity))
        .join(SECTION_GAP);

    const headline = formatHeadline({
        summary: combined.summary,
        granularity,
        hotspots: input.hotspots,
        ownership: input.ownership,
        busFactorThreshold: input.busFactorThreshold,
    });

    const sections = [
        `# Engineering report — ${run.window.label}${SECTION_GAP}${fencedBlock(headline)}`,
        `## Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(combined.perPeriod))}`,
        `## Timeline${SECTION_GAP}${renderMarkdown(timelineTable(input.timeline))}`,
        `## Contributors${SECTION_GAP}${contributorsBlock(contributors, input.complexity)}`,
        `## Hotspots${SECTION_GAP}${renderMarkdown(hotspotsTable(input.hotspots))}`,
        `## Ownership & bus-factor${SECTION_GAP}${renderOwnershipReport("md", input.ownership)}`,
        `## Size & complexity${SECTION_GAP}${renderMarkdown(sizeTable(combined.sizeTrend))}`,
        `## Migrations${SECTION_GAP}${migrationsLine(combined.summary.migrations)}`,
        `## Per-repo appendix${SECTION_GAP}${appendix}`,
    ];

    return sections.join(SECTION_GAP);
}
