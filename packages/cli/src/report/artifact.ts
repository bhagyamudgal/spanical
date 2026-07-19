import type {
    DevPeriodRollup,
    FullAggregation,
    MigrationChurn,
    RepoAggregation,
} from "../aggregate/types";
import type { ResolvedRun } from "../cli/resolve-run";
import {
    churnPeriodTable,
    devTable,
    formatCell,
    renderMarkdown,
    sizeTable,
} from "../render";
import type { Granularity } from "../window";
import { formatSummaryBlock } from "./summary-block";

const SECTION_GAP = "\n\n";

function fencedBlock(content: string): string {
    return ["```", content, "```"].join("\n");
}

function migrationsLine(migrations: MigrationChurn): string {
    return `Migrations churn: +${formatCell(migrations.added)} / -${formatCell(migrations.deleted)} (${formatCell(migrations.throughput)} lines, tracked separately from main churn)`;
}

function repoAppendixSection(
    entry: { repo: string; aggregation: RepoAggregation },
    granularity: Granularity
): string {
    return [
        `### ${entry.repo}`,
        fencedBlock(formatSummaryBlock(entry.aggregation.summary, granularity)),
        renderMarkdown(churnPeriodTable(entry.aggregation.perPeriod)),
    ].join(SECTION_GAP);
}

export function buildReportArtifact(input: {
    full: FullAggregation;
    contributors: DevPeriodRollup[];
    run: ResolvedRun;
}): string {
    const { full, contributors, run } = input;
    const { granularity } = run.window;
    const { combined } = full;

    const appendix = full.perRepo
        .map((entry) => repoAppendixSection(entry, granularity))
        .join(SECTION_GAP);

    const sections = [
        `# Engineering report — ${run.window.label}`,
        fencedBlock(formatSummaryBlock(combined.summary, granularity)),
        `## Activity by period${SECTION_GAP}${renderMarkdown(churnPeriodTable(combined.perPeriod))}`,
        `## Migrations${SECTION_GAP}${migrationsLine(combined.summary.migrations)}`,
        `## Contributors${SECTION_GAP}${renderMarkdown(devTable(contributors, { includePeriod: false }))}`,
        `## Size & complexity${SECTION_GAP}${renderMarkdown(sizeTable(combined.sizeTrend))}`,
        `## Per-repo appendix${SECTION_GAP}${appendix}`,
    ];

    return sections.join(SECTION_GAP);
}
