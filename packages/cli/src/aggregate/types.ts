import type { SpanicalConfig } from "../config/schema";

export type TicketAttribution = NonNullable<
    SpanicalConfig["tickets"]
>["attribution"];

export type TicketCounts = {
    opened: number;
    merged: number;
    closed: number;
    reopened: number;
    reverted: number;
};

export type TicketFlow = {
    cycleTimeMedianHours: number | null;
    pullRequestSizeMedian: number | null;
};

export type DevTicketRollup = TicketCounts &
    TicketFlow & {
        authorId: number;
        author: string;
    };

export type TicketTeamRollup = TicketCounts &
    TicketFlow & {
        unmatchedReverts: number;
        cycleTimesDiscarded: number;
    };

export type PullRequestSizeBucket = {
    label: string;
    pullRequests: number;
    share: number;
};

export type SyncFloor = { repo: string; since: string };

// What span of ticket history the cache actually holds, and what the counts
// span: a consumer diffing two runs has to be able to tell a complete window
// from a partial one, and whether issues share the opened and closed counts.
export type TicketCoverage = {
    includeIssues: boolean;
    lateSyncFloors: SyncFloor[];
};

export type TicketAggregation = {
    attribution: TicketAttribution;
    coverage: TicketCoverage;
    devs: DevTicketRollup[];
    team: TicketTeamRollup;
    pullRequestSizes: PullRequestSizeBucket[];
    unattributed: TicketCounts;
};

// Which clock a Review latency sample started from: "requested" where a review
// request was cached, "created" where it falls back to the pull request opening.
export type LatencyBasis = "requested" | "created";

// The sample counts travel with the median because the two bases measure
// different things: a median drawn mostly from the fallback reads as
// responsiveness to an ask that was never made.
export type ReviewLatency = {
    latencyMedianHours: number | null;
    requestedSamples: number;
    createdSamples: number;
    fallbackShare: number | null;
};

export type DevReviewRollup = ReviewLatency & {
    authorId: number;
    author: string;
    reviewsGiven: number;
};

export type ReviewTeamRollup = ReviewLatency & {
    reviewsGiven: number;
    latencySamplesDiscarded: number;
};

// Team-level only, never per dev: the share of the window's merged pull requests
// carrying a review from anyone other than their own author. The unmerged count
// travels with it so the population left out of the denominator stays visible —
// "1 of 1 (100%)" reads very differently beside nine open pull requests.
export type ReviewCoverage = {
    pullRequestsMerged: number;
    pullRequestsReviewed: number;
    pullRequestsUnmerged: number;
    share: number | null;
};

// Reviews the window held that no metric could count. Carried as data because
// "nothing was found" and "everything found was excluded by definition" call
// for opposite responses from the reader.
export type ExcludedReviews = {
    selfReviews: number;
    pendingReviews: number;
};

export type ReviewAggregation = {
    coverage: ReviewCoverage;
    excluded: ExcludedReviews;
    lateSyncFloors: SyncFloor[];
    devs: DevReviewRollup[];
    team: ReviewTeamRollup;
    unattributed: { reviewsGiven: number; latencySamples: number };
};

export type DevPeriodRollup = {
    period: string;
    authorId: number;
    author: string;
    commits: number;
    added: number;
    deleted: number;
    net: number;
    throughput: number;
    filesTouched: number;
    avgCommitSize: number | null;
    activeDays: number;
};

export type PeriodRollup = {
    period: string;
    commits: number;
    added: number;
    deleted: number;
    net: number;
    throughput: number;
    migrationsAdded: number;
    migrationsDeleted: number;
};

export type LanguageSize = {
    language: string;
    code: number;
};

export type SizeTrendPoint = {
    month: string;
    totalCode: number;
    totalComplexity: number;
    languages: LanguageSize[];
};

export type MigrationChurn = {
    added: number;
    deleted: number;
    throughput: number;
};

export type CodebaseSummary = {
    netGrowth: number;
    totalChurn: number;
    commits: number;
    activeDevs: number;
    busiestPeriod: string | null;
    growthEfficiency: number | null;
    migrations: MigrationChurn;
    totalSizeNow: number;
};

export type DominantCommitSubtype = "landing" | "removal" | "restructure";

export type TimelineEvent =
    | {
          kind: "dominant-commit";
          label: string;
          sha: string;
          subject: string;
          share: number;
          subtype: DominantCommitSubtype;
      }
    | { kind: "churn-spike"; label: string; multiple: number }
    | { kind: "removal"; label: string }
    | { kind: "busiest"; label: string };

export type TimelinePeriod = {
    period: string;
    net: number;
    throughput: number;
    commits: number;
    activeDevs: number;
    events: TimelineEvent[];
};

export type OwnershipAuthorShare = {
    author: string;
    survivingLines: number;
    share: number;
};

export type OwnershipRow = {
    repo: string;
    path: string;
    totalLines: number;
    ownerCount: number;
    primaryOwner: string | null;
    primaryShare: number;
    isSoleOwned: boolean;
    soleOwner: string | null;
    shares: OwnershipAuthorShare[];
};

export type BusFactorRow = {
    repo: string;
    dir: string;
    soleOwnedCount: number;
    owners: string[];
};

export type HotspotRow = {
    repo: string;
    path: string;
    changeFrequency: number;
    complexity: number;
    freqNorm: number;
    cxNorm: number;
    score: number;
    ownerCount: number;
};

export type DevComplexityRollup = {
    author: string;
    authorId: number;
    complexityAdded: number;
    complexityRemoved: number;
    complexityNet: number;
    complexityPerAddedLine: number | null;
    hotspotContribution: number | null;
};

export type ComplexityAttribution = {
    devs: DevComplexityRollup[];
    unattributed: number;
};

export type OwnershipAggregation = {
    files: OwnershipRow[];
    busFactor: BusFactorRow[];
};

export type RepoAggregation = {
    summary: CodebaseSummary;
    perPeriod: PeriodRollup[];
    perDev: DevPeriodRollup[];
    sizeTrend: SizeTrendPoint[];
};

export type FullAggregation = {
    combined: RepoAggregation;
    perRepo: { repo: string; aggregation: RepoAggregation }[];
};
