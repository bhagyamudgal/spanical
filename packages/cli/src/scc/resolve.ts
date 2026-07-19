import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryCatch } from "@spanical/utils";
import {
    SCC_BINARY_NAME,
    SCC_INSTALL_DIR,
    SCC_PLATFORM_ASSETS,
    SCC_RELEASE_BASE_URL,
    type SccAsset,
} from "./constants";
import { SCC_ERROR_CODES, SccError } from "./errors";

type ResolveDeps = {
    which?: (command: string) => string | null;
    installDir?: string;
    platform?: string;
    arch?: string;
};

export function sccAssetForPlatform(platform: string, arch: string): SccAsset {
    const asset = SCC_PLATFORM_ASSETS[`${platform}/${arch}`];
    if (!asset) {
        throw new SccError(
            SCC_ERROR_CODES.UNSUPPORTED_PLATFORM,
            `scc has no prebuilt binary for ${platform}/${arch}. Supported: ${Object.keys(SCC_PLATFORM_ASSETS).join(", ")}.`
        );
    }
    return asset;
}

export function verifyChecksum(
    bytes: Uint8Array,
    expectedSha256: string
): boolean {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(bytes);
    return hasher.digest("hex") === expectedSha256;
}

export async function resolveSccBinary(
    deps: ResolveDeps = {}
): Promise<string> {
    const which = deps.which ?? Bun.which;
    const installDir = deps.installDir ?? SCC_INSTALL_DIR;
    const platform = deps.platform ?? process.platform;
    const arch = deps.arch ?? process.arch;

    const onPath = which("scc");
    if (onPath) {
        return onPath;
    }

    const installedPath = join(installDir, SCC_BINARY_NAME);
    if (existsSync(installedPath)) {
        return installedPath;
    }

    return downloadSccBinary(installDir, installedPath, platform, arch);
}

async function downloadSccBinary(
    installDir: string,
    installedPath: string,
    platform: string,
    arch: string
): Promise<string> {
    const { asset, sha256 } = sccAssetForPlatform(platform, arch);
    const url = `${SCC_RELEASE_BASE_URL}${asset}`;

    const response = await fetchAsset(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!verifyChecksum(bytes, sha256)) {
        throw new SccError(
            SCC_ERROR_CODES.CHECKSUM_MISMATCH,
            `Checksum mismatch for ${asset}; refusing to install. Expected ${sha256}.`
        );
    }

    const workDir = mkdtempSync(join(tmpdir(), "spanical-scc-download-"));
    try {
        const archivePath = join(workDir, asset);
        writeFileSync(archivePath, bytes);
        await extractSccBinary(archivePath, workDir);

        mkdirSync(installDir, { recursive: true });
        const stagedPath = join(
            installDir,
            `.${SCC_BINARY_NAME}.${process.pid}.tmp`
        );
        copyFileSync(join(workDir, SCC_BINARY_NAME), stagedPath);
        chmodSync(stagedPath, 0o755);
        renameSync(stagedPath, installedPath);
        return installedPath;
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

async function fetchAsset(url: string): Promise<Response> {
    const result = await tryCatch(fetch(url));
    if (result.error) {
        throw new SccError(
            SCC_ERROR_CODES.DOWNLOAD_FAILED,
            `Failed to download scc from ${url}: ${result.error.message}`,
            { cause: result.error }
        );
    }
    if (!result.data.ok) {
        throw new SccError(
            SCC_ERROR_CODES.DOWNLOAD_FAILED,
            `Failed to download scc from ${url}: HTTP ${result.data.status}.`
        );
    }
    return result.data;
}

async function extractSccBinary(
    archivePath: string,
    destDir: string
): Promise<void> {
    const proc = Bun.spawn(
        ["tar", "-xzf", archivePath, "-C", destDir, SCC_BINARY_NAME],
        { stdout: "pipe", stderr: "pipe" }
    );
    const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        throw new SccError(
            SCC_ERROR_CODES.DOWNLOAD_FAILED,
            `Failed to extract scc from ${archivePath}: ${stderr.trim()}`
        );
    }
}
