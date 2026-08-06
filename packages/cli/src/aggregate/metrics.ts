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

export type TicketMetricKey =
    | "opened"
    | "merged"
    | "closed"
    | "reopened"
    | "reverted"
    | "cycleTimeMedianHours"
    | "pullRequestSizeMedian";

export type MetricDefinition<Key extends string = string> = {
    key: Key;
    label: string;
    flag: ReadFlag;
};

export const PER_DEV_METRICS: MetricDefinition<PerDevMetricKey>[] = [
    { key: "commits", label: "Commits", flag: "trap" },
    { key: "added", label: "Lines added", flag: "trap" },
    { key: "deleted", label: "Lines deleted", flag: "trap" },
    { key: "net", label: "Net lines", flag: "trap" },
    { key: "throughput", label: "Throughput churn", flag: "context" },
    { key: "filesTouched", label: "Files touched", flag: "context" },
    { key: "avgCommitSize", label: "Avg commit size", flag: "signal" },
    { key: "activeDays", label: "Active days", flag: "signal" },
];

export const TICKET_METRICS: MetricDefinition<TicketMetricKey>[] = [
    { key: "opened", label: "Opened", flag: "trap" },
    { key: "merged", label: "Merged", flag: "trap" },
    { key: "closed", label: "Closed", flag: "trap" },
    { key: "reopened", label: "Reopened", flag: "context" },
    { key: "reverted", label: "Reverted", flag: "context" },
    { key: "cycleTimeMedianHours", label: "Cycle time h", flag: "signal" },
    { key: "pullRequestSizeMedian", label: "PR size", flag: "signal" },
];
