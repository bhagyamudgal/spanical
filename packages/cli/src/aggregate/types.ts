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
