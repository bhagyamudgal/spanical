import { expect, test } from "bun:test";
import { TZDate } from "@date-fns/tz";
import { computeBounds, generatePeriods } from "./boundaries";
import { WindowError } from "./errors";
import { chooseGranularity, resolveGranularity } from "./granularity";
import { parseWindow } from "./parse";
import { resolveWindow } from "./resolve";

test("parseWindow defaults to the last 12 months when no flags are given", () => {
    expect(parseWindow({})).toEqual({ kind: "last", count: 12, unit: "m" });
});

test("parseWindow parses a --last value in days", () => {
    expect(parseWindow({ last: "30d" })).toEqual({
        kind: "last",
        count: 30,
        unit: "d",
    });
});

test("parseWindow parses a --last value in weeks", () => {
    expect(parseWindow({ last: "6w" })).toEqual({
        kind: "last",
        count: 6,
        unit: "w",
    });
});

test("parseWindow parses a --last value in months", () => {
    expect(parseWindow({ last: "12m" })).toEqual({
        kind: "last",
        count: 12,
        unit: "m",
    });
});

test("parseWindow parses a --last value in quarters", () => {
    expect(parseWindow({ last: "4q" })).toEqual({
        kind: "last",
        count: 4,
        unit: "q",
    });
});

test("parseWindow parses a --last value in years", () => {
    expect(parseWindow({ last: "1y" })).toEqual({
        kind: "last",
        count: 1,
        unit: "y",
    });
});

test("parseWindow parses --this quarter", () => {
    expect(parseWindow({ this: "quarter" })).toEqual({
        kind: "this",
        unit: "quarter",
    });
});

test("parseWindow parses --ytd", () => {
    expect(parseWindow({ ytd: true })).toEqual({ kind: "ytd" });
});

test("parseWindow captures --since alone with a null until", () => {
    expect(parseWindow({ since: "2026-01-01" })).toEqual({
        kind: "range",
        since: "2026-01-01",
        until: null,
    });
});

test("parseWindow captures --until alone with a null since", () => {
    expect(parseWindow({ until: "2026-03-01" })).toEqual({
        kind: "range",
        since: null,
        until: "2026-03-01",
    });
});

test("parseWindow treats since and until together as one range, not a conflict", () => {
    expect(parseWindow({ since: "2026-01-01", until: "2026-03-01" })).toEqual({
        kind: "range",
        since: "2026-01-01",
        until: "2026-03-01",
    });
});

test("parseWindow rejects --last combined with --this as conflicting", () => {
    expect(() => parseWindow({ last: "30d", this: "month" })).toThrow(
        WindowError
    );
});

test("parseWindow rejects --ytd combined with --since as conflicting", () => {
    try {
        parseWindow({ ytd: true, since: "2026-01-01" });
        throw new Error("expected parseWindow to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(WindowError);
        if (error instanceof WindowError) {
            expect(error.code).toBe("WINDOW_CONFLICTING_SELECTORS");
        }
    }
});

test("parseWindow rejects a --last value with an unknown unit", () => {
    expect(() => parseWindow({ last: "5x" })).toThrow(WindowError);
});

test("parseWindow rejects a --last value with no unit", () => {
    expect(() => parseWindow({ last: "30" })).toThrow(WindowError);
});

test("parseWindow rejects a --last count of zero", () => {
    expect(() => parseWindow({ last: "0d" })).toThrow(WindowError);
    expect(() => parseWindow({ last: "0m" })).toThrow(WindowError);
});

test("parseWindow rejects a --last count beyond the safe integer range", () => {
    expect(() => parseWindow({ last: "99999999999999999999d" })).toThrow(
        WindowError
    );
});

test("parseWindow rejects a --this value that is not a known unit", () => {
    try {
        parseWindow({ this: "bogus" });
        throw new Error("expected parseWindow to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(WindowError);
        if (error instanceof WindowError) {
            expect(error.code).toBe("WINDOW_INVALID_THIS_UNIT");
        }
    }
});

test("parseWindow rejects a --since value with an impossible month and day", () => {
    expect(() => parseWindow({ since: "2026-13-99" })).toThrow(WindowError);
});

test("parseWindow rejects a --since value that is not a real calendar date", () => {
    expect(() => parseWindow({ since: "2026-02-30" })).toThrow(WindowError);
});

test("parseWindow rejects an --until value that is not a date at all", () => {
    expect(() => parseWindow({ until: "not-a-date" })).toThrow(WindowError);
});

test("parseWindow rejects a --since value that is not zero-padded", () => {
    expect(() => parseWindow({ since: "2026-1-1" })).toThrow(WindowError);
});

test("parseWindow accepts a range of two valid calendar dates", () => {
    expect(parseWindow({ since: "2026-01-01", until: "2026-03-01" })).toEqual({
        kind: "range",
        since: "2026-01-01",
        until: "2026-03-01",
    });
});

test("parseWindow rejects a reversed range where since is after until", () => {
    try {
        parseWindow({ since: "2026-05-01", until: "2026-01-01" });
        throw new Error("expected parseWindow to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(WindowError);
        if (error instanceof WindowError) {
            expect(error.code).toBe("WINDOW_INVALID_RANGE_ORDER");
        }
    }
});

test("parseWindow accepts a same-day range where since equals until", () => {
    expect(parseWindow({ since: "2026-01-01", until: "2026-01-01" })).toEqual({
        kind: "range",
        since: "2026-01-01",
        until: "2026-01-01",
    });
});

const NOW = new TZDate("2026-07-18T12:00:00Z", "UTC");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function instant(iso: string): number {
    return new Date(iso).getTime();
}

test("computeBounds --last 30d ends at now and starts 30 days earlier", () => {
    const bounds = computeBounds(
        { kind: "last", count: 30, unit: "d" },
        "UTC",
        NOW
    );
    expect(bounds.start?.getTime()).toBe(instant("2026-06-18T12:00:00.000Z"));
    expect(bounds.end).toBe(NOW);
});

test("computeBounds --last 12m starts twelve months before now", () => {
    const bounds = computeBounds(
        { kind: "last", count: 12, unit: "m" },
        "UTC",
        NOW
    );
    expect(bounds.start?.getTime()).toBe(instant("2025-07-18T12:00:00.000Z"));
    expect(bounds.end).toBe(NOW);
});

test("computeBounds --this month spans the whole month in UTC", () => {
    const bounds = computeBounds({ kind: "this", unit: "month" }, "UTC", NOW);
    expect(bounds.start?.getTime()).toBe(instant("2026-07-01T00:00:00.000Z"));
    expect(bounds.end.getTime()).toBe(instant("2026-07-31T23:59:59.999Z"));
});

test("computeBounds --ytd starts at the year boundary and ends at now", () => {
    const bounds = computeBounds({ kind: "ytd" }, "UTC", NOW);
    expect(bounds.start?.getTime()).toBe(instant("2026-01-01T00:00:00.000Z"));
    expect(bounds.end).toBe(NOW);
});

test("computeBounds range with since alone runs from since to now", () => {
    const bounds = computeBounds(
        { kind: "range", since: "2026-01-01", until: null },
        "UTC",
        NOW
    );
    expect(bounds.start?.getTime()).toBe(instant("2026-01-01T00:00:00.000Z"));
    expect(bounds.end).toBe(NOW);
});

test("computeBounds range with until alone has a null start", () => {
    const bounds = computeBounds(
        { kind: "range", since: null, until: "2026-03-01" },
        "UTC",
        NOW
    );
    expect(bounds.start).toBeNull();
    expect(bounds.end.getTime()).toBe(instant("2026-03-01T23:59:59.999Z"));
});

test("computeBounds --this month resolves to different instants per zone", () => {
    const kolkata = computeBounds(
        { kind: "this", unit: "month" },
        "Asia/Kolkata",
        NOW
    );
    const berlin = computeBounds(
        { kind: "this", unit: "month" },
        "Europe/Berlin",
        NOW
    );
    expect(kolkata.start?.getTime()).not.toBe(berlin.start?.getTime());
});

test("computeBounds range since is wall-clock midnight in the configured zone", () => {
    const bounds = computeBounds(
        { kind: "range", since: "2026-01-01", until: null },
        "Asia/Kolkata",
        NOW
    );
    expect(bounds.start?.getTime()).toBe(instant("2025-12-31T18:30:00.000Z"));
});

test("generatePeriods weekly buckets stay contiguous across a DST change", () => {
    const start = new TZDate(2026, 2, 16, "Europe/Berlin");
    const end = new TZDate(2026, 3, 5, "Europe/Berlin");
    const periods = generatePeriods(start, end, "week", "Europe/Berlin");

    expect(periods).toHaveLength(3);
    for (const period of periods) {
        expect(period.start.getTime()).toBeLessThan(period.end.getTime());
    }
    for (let index = 0; index < periods.length - 1; index++) {
        const current = periods[index];
        const next = periods[index + 1];
        if (current === undefined || next === undefined) {
            throw new Error("expected contiguous periods");
        }
        const gap = next.start.getTime() - current.end.getTime();
        expect(current.end.getTime()).toBeLessThan(next.start.getTime());
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThan(MS_PER_DAY);
    }
});

test("generatePeriods monthly labels each calendar month in the interval", () => {
    const start = new TZDate(2026, 0, 1, "UTC");
    const end = new TZDate(2026, 2, 31, "UTC");
    const periods = generatePeriods(start, end, "month", "UTC");
    expect(periods.map((period) => period.label)).toEqual([
        "2026-01",
        "2026-02",
        "2026-03",
    ]);
});

test("generatePeriods returns no buckets when the start is null", () => {
    expect(generatePeriods(null, NOW, "month", "UTC")).toEqual([]);
});

test("chooseGranularity picks week for a span of exactly eight weeks", () => {
    const start = new TZDate(2026, 0, 4, "UTC");
    const end = new TZDate(2026, 2, 1, "UTC");
    expect(chooseGranularity(start, end, "UTC")).toBe("week");
});

test("chooseGranularity picks month one day past the weekly cutoff", () => {
    const start = new TZDate(2026, 0, 4, "UTC");
    const end = new TZDate(2026, 2, 2, "UTC");
    expect(chooseGranularity(start, end, "UTC")).toBe("month");
});

test("chooseGranularity picks month for a span of exactly eighteen months", () => {
    const start = new TZDate(2025, 0, 15, "UTC");
    const end = new TZDate(2026, 6, 15, "UTC");
    expect(chooseGranularity(start, end, "UTC")).toBe("month");
});

test("chooseGranularity picks quarter one day past the monthly cutoff", () => {
    const start = new TZDate(2025, 0, 31, "UTC");
    const end = new TZDate(2026, 7, 1, "UTC");
    expect(chooseGranularity(start, end, "UTC")).toBe("quarter");
});

test("resolveGranularity lets an override win over what auto would pick", () => {
    const start = new TZDate(2023, 0, 1, "UTC");
    const end = new TZDate(2026, 0, 1, "UTC");
    expect(chooseGranularity(start, end, "UTC")).toBe("quarter");
    expect(resolveGranularity(start, end, "UTC", "week")).toBe("week");
});

test("resolveGranularity defaults an open start to month", () => {
    const end = new TZDate(2026, 0, 1, "UTC");
    expect(resolveGranularity(null, end, "UTC")).toBe("month");
});

test("resolveGranularity delegates to chooseGranularity without an override", () => {
    const start = new TZDate(2026, 0, 5, "UTC");
    const end = new TZDate(2026, 1, 2, "UTC");
    expect(resolveGranularity(start, end, "UTC")).toBe("week");
    expect(resolveGranularity(start, end, "UTC")).toBe(
        chooseGranularity(start, end, "UTC")
    );
});

test("resolveWindow defaults to twelve monthly buckets labelled last 12m", () => {
    const resolved = resolveWindow({ flags: {}, timezone: "UTC", now: NOW });
    expect(resolved.granularity).toBe("month");
    expect(resolved.periods.length).toBeGreaterThanOrEqual(12);
    expect(resolved.periods.length).toBeLessThanOrEqual(13);
    expect(resolved.label).toContain("last 12m");
});

test("resolveWindow picks weekly granularity for a short last 30d window", () => {
    const resolved = resolveWindow({
        flags: { last: "30d" },
        timezone: "UTC",
        now: NOW,
    });
    expect(resolved.granularity).toBe("week");
    expect(resolved.label).toContain("last 30d");
});

test("resolveWindow labels an open start as history with no periods", () => {
    const resolved = resolveWindow({
        flags: { until: "2026-03-01" },
        timezone: "UTC",
        now: NOW,
    });
    expect(resolved.start).toBeNull();
    expect(resolved.periods).toEqual([]);
    expect(resolved.label.startsWith("history →")).toBe(true);
});

test("resolveWindow lets a period override beat the auto granularity", () => {
    const resolved = resolveWindow({
        flags: { last: "30d" },
        timezone: "UTC",
        now: NOW,
        period: "quarter",
    });
    expect(resolved.granularity).toBe("quarter");
});
