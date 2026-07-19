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
