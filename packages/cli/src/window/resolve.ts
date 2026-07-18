import { tz } from "@date-fns/tz";
import { format } from "date-fns";
import { computeBounds, generatePeriods } from "./boundaries";
import { resolveGranularity } from "./granularity";
import { parseWindow, type WindowFlags } from "./parse";
import type { Granularity, ResolvedWindow, WindowRequest } from "./types";

const LABEL_MONTH_FORMAT = "yyyy-MM";

function describeRequest(request: WindowRequest): string {
    switch (request.kind) {
        case "last":
            return `last ${request.count}${request.unit}`;
        case "this":
            return `this ${request.unit}`;
        case "ytd":
            return "ytd";
        case "range":
            return "";
    }
}

function buildLabel(
    request: WindowRequest,
    start: Date | null,
    end: Date,
    timezone: string
): string {
    const context = { in: tz(timezone) };
    const endToken = format(end, LABEL_MONTH_FORMAT, context);
    if (start === null) {
        return `history → ${endToken}`;
    }
    const startToken = format(start, LABEL_MONTH_FORMAT, context);
    const descriptor = describeRequest(request);
    if (descriptor.length > 0) {
        return `${descriptor} (${startToken} → ${endToken})`;
    }
    return `${startToken} → ${endToken}`;
}

export function resolveWindow(input: {
    flags: WindowFlags;
    timezone: string;
    now: Date;
    period?: Granularity;
}): ResolvedWindow {
    const request = parseWindow(input.flags);
    const { start, end } = computeBounds(request, input.timezone, input.now);
    const granularity = resolveGranularity(
        start,
        end,
        input.timezone,
        input.period
    );
    const periods = generatePeriods(start, end, granularity, input.timezone);
    const label = buildLabel(request, start, end, input.timezone);
    return { start, end, granularity, periods, label };
}
