import { boolean, string } from "@drizzle-team/brocli";

export const globalFlags = {
    config: string().desc("Path to spanical.config.ts"),
    repo: string().desc("Repo path(s), comma-separated; overrides config"),
    last: string().desc("Relative window, e.g. 30d, 6m, 1y"),
    this: string()
        .enum("week", "month", "quarter", "year")
        .desc("Current calendar period"),
    ytd: boolean().desc("Year to date"),
    since: string().desc("Window start (YYYY-MM-DD)"),
    until: string().desc("Window end (YYYY-MM-DD)"),
    period: string().enum("week", "month", "quarter").desc("Force granularity"),
    tz: string().desc("IANA timezone for period boundaries"),
    exclude: string().desc(
        "Exclude glob(s), comma-separated; overrides config"
    ),
    by: string().enum("dev", "file", "dir", "language").desc("Grouping axis"),
    format: string().enum("table", "json", "md").desc("Output format"),
    out: string().desc("Write report to file"),
    "no-cache": boolean().desc("Force fresh extraction"),
};
