import { join } from "node:path";
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import type { ResolvedWindow } from "../window";

const MONTH_FORMAT = "yyyy-MM";

function monthSlug(date: Date, timezone: string): string {
    return format(new TZDate(date, timezone), MONTH_FORMAT);
}

export function defaultReportPath(
    window: ResolvedWindow,
    timezone: string,
    cwd?: string
): string {
    const endMonth = monthSlug(window.end, timezone);
    const slug =
        window.start === null
            ? `history_${endMonth}`
            : `${monthSlug(window.start, timezone)}_${endMonth}`;
    return join(cwd ?? process.cwd(), `spanical-report-${slug}.md`);
}
