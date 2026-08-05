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
import {
    ticketSections,
    type TicketInsight,
    type TicketRefreshFailure,
} from "./ticket-layer";

const SECTION_GAP = "\n\n";
const COMBINED_SECTION_LEVEL = 2;
const APPENDIX_SECTION_LEVEL = 4;

export type PerRepoInsight = {
    repo: string;
    aggregation: RepoAggregation;
    contributors: DevPeriodRollup[];
    hotspots: HotspotRow[];
    ownership: OwnershipAggregation;
    complexity: ComplexityAttribution;
    timeline: TimelinePeriod[];
    tickets: TicketInsight | null;
};

// Null where no GitHub token or no tickets config was found: the report then
// renders exactly its offline sections rather than an empty ticket placeholder.
export type ReportTickets = {
    insight: TicketInsight;
    failure: TicketRefreshFailure | null;
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
    tickets: ReportTickets | null;
    run: ResolvedRun;
};

type AppendixContext = {
    granularity: Granularity;
    window: string;
    ticketFailure: TicketRefreshFailure | null;
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
    context: AppendixContext
): string {
    const ticketBlocks =
        insight.tickets === null
            ? []
            : ticketSections({
                  insight: insight.tickets,
                  failure: context.ticketFailure,
                  window: context.window,
                  repos: [insight.repo],
                  level: APPENDIX_SECTION_LEVEL,
              });
    return [
        `### ${insight.repo}`,
        fencedBlock(
            formatSummaryBlock(insight.aggregation.summary, context.granularity)
        ),
        `#### Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(insight.aggregation.perPeriod))}`,
        `#### Hotspots${SECTION_GAP}${renderMarkdown(hotspotsTable(insight.hotspots))}`,
        `#### Ownership & bus-factor${SECTION_GAP}${renderOwnershipReport("md", insight.ownership)}`,
        `#### Timeline${SECTION_GAP}${renderMarkdown(timelineTable(insight.timeline))}`,
        `#### Contributors${SECTION_GAP}${contributorsBlock(insight.contributors, insight.complexity)}`,
        ...ticketBlocks,
    ].join(SECTION_GAP);
}

export function buildReportArtifact(input: ReportArtifactInput): string {
    const { full, contributors, run } = input;
    const { granularity } = run.window;
    const { combined } = full;
    const repoNames = run.repos.map((repo) => repo.name);

    const appendix = input.perRepoInsights
        .map((insight) =>
            repoAppendixSection(insight, {
                granularity,
                window: run.window.label,
                ticketFailure: input.tickets?.failure ?? null,
            })
        )
        .join(SECTION_GAP);

    const headline = formatHeadline({
        summary: combined.summary,
        granularity,
        hotspots: input.hotspots,
        ownership: input.ownership,
        busFactorThreshold: input.busFactorThreshold,
    });

    const ticketBlocks =
        input.tickets === null
            ? []
            : ticketSections({
                  insight: input.tickets.insight,
                  failure: input.tickets.failure,
                  window: run.window.label,
                  repos: repoNames,
                  level: COMBINED_SECTION_LEVEL,
              });

    const sections = [
        `# Engineering report — ${run.window.label}${SECTION_GAP}${fencedBlock(headline)}`,
        `## Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(combined.perPeriod))}`,
        `## Timeline${SECTION_GAP}${renderMarkdown(timelineTable(input.timeline))}`,
        `## Contributors${SECTION_GAP}${contributorsBlock(contributors, input.complexity)}`,
        ...ticketBlocks,
        `## Hotspots${SECTION_GAP}${renderMarkdown(hotspotsTable(input.hotspots))}`,
        `## Ownership & bus-factor${SECTION_GAP}${renderOwnershipReport("md", input.ownership)}`,
        `## Size & complexity${SECTION_GAP}${renderMarkdown(sizeTable(combined.sizeTrend))}`,
        `## Migrations${SECTION_GAP}${migrationsLine(combined.summary.migrations)}`,
        `## Per-repo appendix${SECTION_GAP}${appendix}`,
    ];

    return sections.join(SECTION_GAP);
}
