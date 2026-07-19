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
