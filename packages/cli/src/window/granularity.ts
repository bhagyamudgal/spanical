import { tz } from "@date-fns/tz";
import {
    differenceInCalendarMonths,
    differenceInCalendarWeeks,
} from "date-fns";
import { WEEK_STARTS_ON_MONDAY } from "./constants";
import type { Granularity } from "./types";

const WEEKLY_MAX_WEEKS = 8;
const MONTHLY_MAX_MONTHS = 18;
const DEFAULT_OPEN_START_GRANULARITY = "month";

export function chooseGranularity(
    start: Date,
    end: Date,
    timezone: string
): Granularity {
    if (
        differenceInCalendarWeeks(end, start, {
            weekStartsOn: WEEK_STARTS_ON_MONDAY,
            in: tz(timezone),
        }) <= WEEKLY_MAX_WEEKS
    ) {
        return "week";
    }
    if (
        differenceInCalendarMonths(end, start, { in: tz(timezone) }) <=
        MONTHLY_MAX_MONTHS
    ) {
        return "month";
    }
    return "quarter";
}

export function resolveGranularity(
    start: Date | null,
    end: Date,
    timezone: string,
    override?: Granularity
): Granularity {
    if (override !== undefined) {
        return override;
    }
    if (start === null) {
        return DEFAULT_OPEN_START_GRANULARITY;
    }
    return chooseGranularity(start, end, timezone);
}
