export type ReadFlag = "signal" | "context" | "trap";

export type PerDevMetricKey =
    | "commits"
    | "added"
    | "deleted"
    | "net"
    | "throughput"
    | "filesTouched"
    | "avgCommitSize"
    | "activeDays";

export type MetricDefinition = {
    key: PerDevMetricKey;
    label: string;
    flag: ReadFlag;
};

export const PER_DEV_METRICS: MetricDefinition[] = [
    { key: "commits", label: "Commits", flag: "trap" },
    { key: "added", label: "Lines added", flag: "trap" },
    { key: "deleted", label: "Lines deleted", flag: "trap" },
    { key: "net", label: "Net lines", flag: "trap" },
    { key: "throughput", label: "Throughput churn", flag: "context" },
    { key: "filesTouched", label: "Files touched", flag: "context" },
    { key: "avgCommitSize", label: "Avg commit size", flag: "signal" },
    { key: "activeDays", label: "Active days", flag: "signal" },
];
