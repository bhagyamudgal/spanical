import {
    differenceInCalendarMonths,
    differenceInCalendarWeeks,
} from "date-fns";
import type { Granularity } from "./types";

const WEEK_STARTS_ON_MONDAY = 1;
const WEEKLY_MAX_WEEKS = 8;
const MONTHLY_MAX_MONTHS = 18;
const DEFAULT_OPEN_START_GRANULARITY = "month";

export function chooseGranularity(start: Date, end: Date): Granularity {
    if (
        differenceInCalendarWeeks(end, start, {
            weekStartsOn: WEEK_STARTS_ON_MONDAY,
        }) <= WEEKLY_MAX_WEEKS
    ) {
        return "week";
    }
    if (differenceInCalendarMonths(end, start) <= MONTHLY_MAX_MONTHS) {
        return "month";
    }
    return "quarter";
}

export function resolveGranularity(
    start: Date | null,
    end: Date,
    override?: Granularity
): Granularity {
    if (override !== undefined) {
        return override;
    }
    if (start === null) {
        return DEFAULT_OPEN_START_GRANULARITY;
    }
    return chooseGranularity(start, end);
}
