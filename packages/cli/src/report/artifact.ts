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
import { reposWithoutWindowEndSnapshot } from "../aggregate";
import type { ResolvedRun } from "../cli/resolve-run";
import {
    churnPeriodTable,
    formatCell,
    renderContributorsReport,
    renderHotspotsReport,
    renderMarkdown,
    renderOwnershipReport,
    renderSizeReport,
    renderTimelineReport,
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
};

// Null where no GitHub token or no tickets config was found: the report then
// renders exactly its offline sections rather than an empty ticket placeholder.
// One nullable field carries the combined insight, the per-repo insights and the
// refresh failure together, so no caller can render appendix ticket counts while
// the warning that they are stale goes missing.
export type ReportTickets = {
    combined: TicketInsight;
    byRepo: Map<string, TicketInsight>;
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
    minFileLines: number;
    busFactorThreshold: number;
    windowEndShas: Map<string, string>;
    tickets: ReportTickets | null;
    run: ResolvedRun;
};

type AppendixContext = {
    granularity: Granularity;
    window: string;
    windowStart: Date | null;
    minFileLines: number;
    busFactorThreshold: number;
    windowEndShas: Map<string, string>;
    tickets: ReportTickets | null;
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

function appendixTicketBlocks(
    repo: string,
    context: AppendixContext
): string[] {
    const { tickets } = context;
    const repoInsight = tickets?.byRepo.get(repo);
    if (tickets === null || repoInsight === undefined) {
        return [];
    }
    return ticketSections({
        insight: repoInsight,
        failure: tickets.failure,
        window: context.window,
        repos: [repo],
        level: APPENDIX_SECTION_LEVEL,
    });
}

function repoAppendixSection(
    insight: PerRepoInsight,
    context: AppendixContext
): string {
    const unmeasuredRepos = reposWithoutWindowEndSnapshot(
        [insight.repo],
        context.windowEndShas
    );
    return [
        `### ${insight.repo}`,
        fencedBlock(
            formatSummaryBlock(
                insight.aggregation.summary,
                context.granularity,
                unmeasuredRepos.length === 0 ? "complete" : "unavailable"
            )
        ),
        `#### Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(insight.aggregation.perPeriod))}`,
        `#### Hotspots${SECTION_GAP}${renderHotspotsReport(
            "md",
            insight.hotspots,
            {
                minFileLines: context.minFileLines,
                unmeasuredRepos,
            }
        )}`,
        `#### Ownership & bus-factor${SECTION_GAP}${renderOwnershipReport(
            "md",
            insight.ownership,
            {
                minFileLines: context.minFileLines,
                busFactorThreshold: context.busFactorThreshold,
            }
        )}`,
        `#### Timeline${SECTION_GAP}${renderTimelineReport("md", insight.timeline, context)}`,
        `#### Contributors${SECTION_GAP}${contributorsBlock(insight.contributors, insight.complexity)}`,
        ...appendixTicketBlocks(insight.repo, context),
    ].join(SECTION_GAP);
}

export function buildReportArtifact(input: ReportArtifactInput): string {
    const { full, contributors, run } = input;
    const { granularity } = run.window;
    const { combined } = full;
    const repoNames = run.repos.map((repo) => repo.name);
    const unmeasuredRepos = reposWithoutWindowEndSnapshot(
        repoNames,
        input.windowEndShas
    );

    const appendix = input.perRepoInsights
        .map((insight) =>
            repoAppendixSection(insight, {
                granularity,
                window: run.window.label,
                windowStart: run.window.start,
                minFileLines: input.minFileLines,
                busFactorThreshold: input.busFactorThreshold,
                windowEndShas: input.windowEndShas,
                tickets: input.tickets,
            })
        )
        .join(SECTION_GAP);

    const headline = formatHeadline({
        summary: combined.summary,
        granularity,
        hotspots: input.hotspots,
        ownership: input.ownership,
        minFileLines: input.minFileLines,
        unmeasuredRepos,
        repoCount: repoNames.length,
        busFactorThreshold: input.busFactorThreshold,
    });

    const ticketBlocks =
        input.tickets === null
            ? []
            : ticketSections({
                  insight: input.tickets.combined,
                  failure: input.tickets.failure,
                  window: run.window.label,
                  repos: repoNames,
                  level: COMBINED_SECTION_LEVEL,
              });

    const sections = [
        `# Engineering report — ${run.window.label}${SECTION_GAP}${fencedBlock(headline)}`,
        `## Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(combined.perPeriod))}`,
        `## Timeline${SECTION_GAP}${renderTimelineReport("md", input.timeline, { windowStart: run.window.start })}`,
        `## Contributors${SECTION_GAP}${contributorsBlock(contributors, input.complexity)}`,
        ...ticketBlocks,
        `## Hotspots${SECTION_GAP}${renderHotspotsReport("md", input.hotspots, {
            minFileLines: input.minFileLines,
            unmeasuredRepos,
        })}`,
        `## Ownership & bus-factor${SECTION_GAP}${renderOwnershipReport(
            "md",
            input.ownership,
            {
                minFileLines: input.minFileLines,
                busFactorThreshold: input.busFactorThreshold,
            }
        )}`,
        `## Size & complexity${SECTION_GAP}${renderSizeReport("md", combined.sizeTrend, { unmeasuredRepos })}`,
        `## Migrations${SECTION_GAP}${migrationsLine(combined.summary.migrations)}`,
        `## Per-repo appendix${SECTION_GAP}${appendix}`,
    ];

    return sections.join(SECTION_GAP);
}
