import { expect, test } from "bun:test";
import { tryCatchSync } from "@spanical/utils";
import { SCC_ERROR_CODES, SccError } from "./errors";
import {
    resolveSccBinary,
    sccAssetForPlatform,
    verifyChecksum,
} from "./resolve";

const SUPPORTED_ASSETS = [
    {
        platform: "darwin",
        arch: "arm64",
        asset: "scc_Darwin_arm64.tar.gz",
        sha256: "376cbae670be59ee64f398de20e0694ec434bf8a9b842642952b0ab0be5f3961",
    },
    {
        platform: "darwin",
        arch: "x64",
        asset: "scc_Darwin_x86_64.tar.gz",
        sha256: "c3f7457856b9169ccb3c1dd14198e67f730bee065f24d9051bf52cdc2a719ecc",
    },
    {
        platform: "linux",
        arch: "arm64",
        asset: "scc_Linux_arm64.tar.gz",
        sha256: "dcb05c6e993bb2d8d2da4765ff018f2e752325dd205a41698929c55e4123575d",
    },
    {
        platform: "linux",
        arch: "x64",
        asset: "scc_Linux_x86_64.tar.gz",
        sha256: "3d9d65b00ca874c2b29151abe7e1480736f5229edc3ce8e4b2791460cdfabf5a",
    },
] as const;

test("sccAssetForPlatform returns the right asset and checksum for every supported combo", () => {
    for (const { platform, arch, asset, sha256 } of SUPPORTED_ASSETS) {
        expect(sccAssetForPlatform(platform, arch)).toEqual({ asset, sha256 });
    }
});

test("sccAssetForPlatform rejects unsupported platform and arch", () => {
    for (const [platform, arch] of [
        ["win32", "x64"],
        ["linux", "riscv64"],
    ] as const) {
        const { error } = tryCatchSync(() =>
            sccAssetForPlatform(platform, arch)
        );
        expect(error).toBeInstanceOf(SccError);
        if (error instanceof SccError) {
            expect(error.code).toBe(SCC_ERROR_CODES.UNSUPPORTED_PLATFORM);
        }
    }
});

test("verifyChecksum accepts a matching digest and rejects a wrong one", () => {
    const bytes = new TextEncoder().encode("spanical scc payload");
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    const digest = hasher.digest("hex");

    expect(verifyChecksum(bytes, digest)).toBe(true);
    expect(verifyChecksum(bytes, "0".repeat(64))).toBe(false);
});

test("resolveSccBinary returns the PATH binary without downloading", async () => {
    const resolved = await resolveSccBinary({
        which: () => "/fake/scc",
        installDir: "/nonexistent/install-dir-should-not-be-touched",
        platform: "win32",
        arch: "riscv64",
    });
    expect(resolved).toBe("/fake/scc");
});
