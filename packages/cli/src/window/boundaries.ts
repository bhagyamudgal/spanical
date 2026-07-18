import { TZDate, tz } from "@date-fns/tz";
import {
    eachMonthOfInterval,
    eachQuarterOfInterval,
    eachWeekOfInterval,
    endOfDay,
    endOfMonth,
    endOfQuarter,
    endOfWeek,
    endOfYear,
    format,
    startOfMonth,
    startOfQuarter,
    startOfWeek,
    startOfYear,
    subDays,
    subMonths,
    subQuarters,
    subWeeks,
    subYears,
} from "date-fns";
import type { Granularity, Period, WindowRequest } from "./types";

type LastUnit = Extract<WindowRequest, { kind: "last" }>["unit"];
type ThisUnit = Extract<WindowRequest, { kind: "this" }>["unit"];
type ZoneContext = { in: ReturnType<typeof tz> };

const WEEK_STARTS_ON_MONDAY = 1;
const WEEK_LABEL_FORMAT = "RRRR-'W'II";
const MONTH_LABEL_FORMAT = "yyyy-MM";
const QUARTER_LABEL_FORMAT = "yyyy-'Q'q";
const DATE_PART_SEPARATOR = "-";
const MONTHS_ZERO_INDEX_OFFSET = 1;

const SUBTRACT_BY_UNIT: Record<
    LastUnit,
    (date: Date, amount: number, options: ZoneContext) => Date
> = {
    d: subDays,
    w: subWeeks,
    m: subMonths,
    q: subQuarters,
    y: subYears,
};

function toZonedStartOfDay(dateString: string, timezone: string): TZDate {
    const [year, month, day] = dateString.split(DATE_PART_SEPARATOR);
    return new TZDate(
        Number(year),
        Number(month) - MONTHS_ZERO_INDEX_OFFSET,
        Number(day),
        timezone
    );
}

function computeThisBounds(
    unit: ThisUnit,
    now: Date,
    context: ZoneContext
): { start: Date; end: Date } {
    switch (unit) {
        case "week":
            return {
                start: startOfWeek(now, {
                    ...context,
                    weekStartsOn: WEEK_STARTS_ON_MONDAY,
                }),
                end: endOfWeek(now, {
                    ...context,
                    weekStartsOn: WEEK_STARTS_ON_MONDAY,
                }),
            };
        case "month":
            return {
                start: startOfMonth(now, context),
                end: endOfMonth(now, context),
            };
        case "quarter":
            return {
                start: startOfQuarter(now, context),
                end: endOfQuarter(now, context),
            };
        case "year":
            return {
                start: startOfYear(now, context),
                end: endOfYear(now, context),
            };
    }
}

export function computeBounds(
    request: WindowRequest,
    timezone: string,
    now: Date
): { start: Date | null; end: Date } {
    const context: ZoneContext = { in: tz(timezone) };
    switch (request.kind) {
        case "last":
            return {
                start: SUBTRACT_BY_UNIT[request.unit](
                    now,
                    request.count,
                    context
                ),
                end: now,
            };
        case "this":
            return computeThisBounds(request.unit, now, context);
        case "ytd":
            return { start: startOfYear(now, context), end: now };
        case "range":
            return {
                start:
                    request.since === null
                        ? null
                        : toZonedStartOfDay(request.since, timezone),
                end:
                    request.until === null
                        ? now
                        : endOfDay(toZonedStartOfDay(request.until, timezone), {
                              in: tz(timezone),
                          }),
            };
    }
}

export function generatePeriods(
    start: Date | null,
    end: Date,
    granularity: Granularity,
    timezone: string
): Period[] {
    if (start === null) {
        return [];
    }
    const context: ZoneContext = { in: tz(timezone) };
    const interval = { start, end };
    switch (granularity) {
        case "week":
            return eachWeekOfInterval(interval, {
                ...context,
                weekStartsOn: WEEK_STARTS_ON_MONDAY,
            }).map((weekStart) => ({
                label: format(weekStart, WEEK_LABEL_FORMAT),
                start: startOfWeek(weekStart, {
                    ...context,
                    weekStartsOn: WEEK_STARTS_ON_MONDAY,
                }),
                end: endOfWeek(weekStart, {
                    ...context,
                    weekStartsOn: WEEK_STARTS_ON_MONDAY,
                }),
            }));
        case "month":
            return eachMonthOfInterval(interval, context).map((monthStart) => ({
                label: format(monthStart, MONTH_LABEL_FORMAT),
                start: startOfMonth(monthStart, context),
                end: endOfMonth(monthStart, context),
            }));
        case "quarter":
            return eachQuarterOfInterval(interval, context).map(
                (quarterStart) => ({
                    label: format(quarterStart, QUARTER_LABEL_FORMAT),
                    start: startOfQuarter(quarterStart, context),
                    end: endOfQuarter(quarterStart, context),
                })
            );
    }
}
