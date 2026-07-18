import { expect, test } from "bun:test";
import { WindowError } from "./errors";
import { parseWindow } from "./parse";

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
