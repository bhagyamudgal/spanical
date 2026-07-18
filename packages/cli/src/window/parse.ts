import { z } from "zod";
import type { WindowRequest } from "./types";
import { WINDOW_ERROR_CODES, WindowError } from "./errors";

const ISO_DATE_SCHEMA = z.iso.date();
const DEFAULT_LAST_COUNT = 12;
const DEFAULT_LAST_UNIT = "m";
const LAST_PATTERN = /^(\d+)(d|w|m|q|y)$/;
const LAST_UNITS = ["d", "w", "m", "q", "y"] as const;
const THIS_UNITS = ["week", "month", "quarter", "year"] as const;

type LastUnit = (typeof LAST_UNITS)[number];
type ThisUnit = (typeof THIS_UNITS)[number];

export type WindowFlags = {
    last?: string;
    this?: string;
    ytd?: boolean;
    since?: string;
    until?: string;
};

function isPresent(value: string | undefined): value is string {
    return value !== undefined && value.length > 0;
}

function assertIsoDate(value: string, flagName: string): void {
    if (!ISO_DATE_SCHEMA.safeParse(value).success) {
        throw new WindowError(
            WINDOW_ERROR_CODES.INVALID_RANGE_DATE,
            `Invalid ${flagName} value "${value}". Expected a real calendar date in YYYY-MM-DD form.`
        );
    }
}

function isLastUnit(value: string): value is LastUnit {
    return LAST_UNITS.some((unit) => unit === value);
}

function isThisUnit(value: string): value is ThisUnit {
    return THIS_UNITS.some((unit) => unit === value);
}

function collectActiveFlagNames(flags: WindowFlags): string[] {
    const names: string[] = [];
    if (isPresent(flags.last)) {
        names.push("--last");
    }
    if (isPresent(flags.this)) {
        names.push("--this");
    }
    if (flags.ytd === true) {
        names.push("--ytd");
    }
    if (isPresent(flags.since)) {
        names.push("--since");
    }
    if (isPresent(flags.until)) {
        names.push("--until");
    }
    return names;
}

export function parseWindow(flags: WindowFlags): WindowRequest {
    const hasLast = isPresent(flags.last);
    const hasThis = isPresent(flags.this);
    const hasYtd = flags.ytd === true;
    const hasRange = isPresent(flags.since) || isPresent(flags.until);

    const activeGroupCount = [hasLast, hasThis, hasYtd, hasRange].filter(
        (isActive) => isActive
    ).length;

    if (activeGroupCount > 1) {
        const conflicting = collectActiveFlagNames(flags).join(", ");
        throw new WindowError(
            WINDOW_ERROR_CODES.CONFLICTING_SELECTORS,
            `Conflicting window selectors: ${conflicting}. Use only one of --last, --this, --ytd, or --since/--until.`
        );
    }

    if (activeGroupCount === 0) {
        return {
            kind: "last",
            count: DEFAULT_LAST_COUNT,
            unit: DEFAULT_LAST_UNIT,
        };
    }

    if (isPresent(flags.last)) {
        const match = flags.last.match(LAST_PATTERN);
        const unit = match?.[2];
        if (match === null || unit === undefined || !isLastUnit(unit)) {
            throw new WindowError(
                WINDOW_ERROR_CODES.INVALID_LAST_FORMAT,
                `Invalid --last value "${flags.last}". Expected a number followed by d, w, m, q, or y (e.g. 30d, 6w, 12m).`
            );
        }
        return { kind: "last", count: Number(match[1]), unit };
    }

    if (isPresent(flags.this)) {
        if (!isThisUnit(flags.this)) {
            throw new WindowError(
                WINDOW_ERROR_CODES.INVALID_THIS_UNIT,
                `Invalid --this value "${flags.this}". Expected one of week, month, quarter, or year.`
            );
        }
        return { kind: "this", unit: flags.this };
    }

    if (hasYtd) {
        return { kind: "ytd" };
    }

    if (isPresent(flags.since)) {
        assertIsoDate(flags.since, "--since");
    }
    if (isPresent(flags.until)) {
        assertIsoDate(flags.until, "--until");
    }

    if (
        isPresent(flags.since) &&
        isPresent(flags.until) &&
        flags.since > flags.until
    ) {
        throw new WindowError(
            WINDOW_ERROR_CODES.INVALID_RANGE_ORDER,
            `--since (${flags.since}) must be on or before --until (${flags.until}).`
        );
    }

    return {
        kind: "range",
        since: flags.since ?? null,
        until: flags.until ?? null,
    };
}
