export type Granularity = "week" | "month" | "quarter";

export type Period = { label: string; start: Date; end: Date };

export type WindowRequest =
    | { kind: "last"; count: number; unit: "d" | "w" | "m" | "q" | "y" }
    | { kind: "this"; unit: "week" | "month" | "quarter" | "year" }
    | { kind: "ytd" }
    | { kind: "range"; since: string | null; until: string | null };

export type ResolvedWindow = {
    start: Date | null;
    end: Date;
    granularity: Granularity;
    periods: Period[];
    label: string;
};
