import { homedir } from "node:os";
import { join } from "node:path";

export const SCC_VERSION = "3.7.0";

export const SCC_RELEASE_BASE_URL = `https://github.com/boyter/scc/releases/download/v${SCC_VERSION}/`;

export type SccAsset = { asset: string; sha256: string };

export const SCC_PLATFORM_ASSETS: Record<string, SccAsset> = {
    "darwin/arm64": {
        asset: "scc_Darwin_arm64.tar.gz",
        sha256: "376cbae670be59ee64f398de20e0694ec434bf8a9b842642952b0ab0be5f3961",
    },
    "darwin/x64": {
        asset: "scc_Darwin_x86_64.tar.gz",
        sha256: "c3f7457856b9169ccb3c1dd14198e67f730bee065f24d9051bf52cdc2a719ecc",
    },
    "linux/arm64": {
        asset: "scc_Linux_arm64.tar.gz",
        sha256: "dcb05c6e993bb2d8d2da4765ff018f2e752325dd205a41698929c55e4123575d",
    },
    "linux/x64": {
        asset: "scc_Linux_x86_64.tar.gz",
        sha256: "3d9d65b00ca874c2b29151abe7e1480736f5229edc3ce8e4b2791460cdfabf5a",
    },
};

export const SCC_BINARY_NAME = "scc";
export const SCC_INSTALL_DIR = join(homedir(), ".spanical", "bin");
export const SCC_BINARY_PATH = join(SCC_INSTALL_DIR, SCC_BINARY_NAME);
