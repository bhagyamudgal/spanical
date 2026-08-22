import { expect, test } from "bun:test";
import { getAssetName, isAllowedReleaseHost } from "./release";

test("getAssetName maps supported platforms and rejects the rest", () => {
    expect(getAssetName("darwin", "arm64")).toBe("spanical-darwin-arm64");
    expect(getAssetName("darwin", "x64")).toBe("spanical-darwin-x64");
    expect(getAssetName("linux", "arm64")).toBe("spanical-linux-arm64");
    expect(getAssetName("linux", "x64")).toBe("spanical-linux-x64");
    expect(getAssetName("win32", "x64")).toBeNull();
    expect(getAssetName("linux", "riscv64")).toBeNull();
});

test("isAllowedReleaseHost accepts release hosts over HTTPS", () => {
    for (const url of [
        "https://api.github.com/repos/bhagyamudgal/spanical/releases/latest",
        "https://github.com/bhagyamudgal/spanical/releases/download/v0.1.0/x",
        "https://objects.githubusercontent.com/some/asset",
        "https://release-assets.githubusercontent.com/some/asset",
        "https://github-releases.githubusercontent.com/some/asset",
    ]) {
        expect(isAllowedReleaseHost(url)).toBe(true);
    }
});

test("isAllowedReleaseHost rejects disallowed hosts and non-HTTPS schemes", () => {
    for (const url of [
        "https://evil.example.com/spanical-darwin-arm64",
        // Host allowlisted but downgraded to cleartext.
        "http://github.com/bhagyamudgal/spanical/releases/download/v0.1.0/x",
        "http://api.github.com/repos/bhagyamudgal/spanical/releases/latest",
        "ftp://github.com/asset",
        "not a url",
    ]) {
        expect(isAllowedReleaseHost(url)).toBe(false);
    }
});
