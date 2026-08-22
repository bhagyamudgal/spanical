import { expect, test } from "bun:test";
import { compareVersions } from "./version";

test("compareVersions orders by major, then minor, then patch", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
});

test("compareVersions tolerates a v prefix and numeric-looking segments", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("v01.02.03", "1.2.3")).toBe(0);
});

test("compareVersions ranks a release above its prereleases and above lower cores", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.1")).toBeLessThan(0);
});

test("compareVersions applies SemVer prerelease identifier rules", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0-rc.2")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    // Numeric identifiers compare numerically, never lexically.
    expect(compareVersions("1.0.0-rc.9", "1.0.0-rc.10")).toBeLessThan(0);
    // Numeric identifiers rank below string identifiers.
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    // A shorter prerelease list ranks below a longer one sharing the same prefix.
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    // Multi-part numeric identifiers compare pairwise.
    expect(
        compareVersions("1.0.0-alpha.2.10", "1.0.0-alpha.2.9")
    ).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.1")).toBe(0);
});
