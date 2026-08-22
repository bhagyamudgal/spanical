import fs from "node:fs/promises";
import { command } from "@drizzle-team/brocli";
import { tryCatch } from "@spanical/utils";
import pkg from "../../package.json";
import { UpdateError, errorCode } from "../update/errors";
import {
    downloadAsset,
    fetchLatestRelease,
    getAssetName,
    isStandalone,
    probeBinaryRuns,
    verifyAssetAgainstSums,
    type VerifyAssetResult,
} from "../update/release";
import { compareVersions } from "../update/version";

const PERMISSION_ERRNOS = new Set(["EACCES", "EPERM", "EROFS"]);

function isPermissionError(error: unknown): boolean {
    const code = errorCode(error);
    return code !== null && PERMISSION_ERRNOS.has(code);
}

function fail(message: string): never {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

function describeVerifyFailure(
    assetName: string,
    verify: Extract<VerifyAssetResult, { ok: false }>
): string {
    switch (verify.kind) {
        case "sums-error":
            return `SHA256SUMS could not be fetched: ${verify.reason}. Refusing to install.`;
        case "missing-entry":
            return `SHA256SUMS is missing an entry for ${assetName}; refusing to install.`;
        case "hash-io-error":
            return `Could not read downloaded binary for hash check: ${verify.cause.message}.`;
        case "hash-mismatch":
            return `Hash mismatch for ${assetName}; refusing to install.`;
    }
}

async function removeQuietly(path: string): Promise<void> {
    const { error } = await tryCatch(fs.rm(path, { force: true }));
    if (error) {
        process.stderr.write(
            `warning: could not remove stale update artifact ${path}: ${error.message}\n`
        );
    }
}

export const updateCommand = command({
    name: "update",
    desc: "Update spanical to the latest release",
    handler: async () => {
        if (!isStandalone()) {
            fail(
                "Update applies only to compiled binaries; running from source. Install a release binary or rebuild with `bun run build`."
            );
        }
        const assetName = getAssetName();
        if (!assetName) {
            fail(`Unsupported platform/arch: ${process.platform}/${process.arch}`);
        }

        const currentVersion = pkg.version;

        const { data: binaryPath, error: realpathError } = await tryCatch(
            fs.realpath(process.execPath)
        );
        if (realpathError) {
            fail(`Failed to resolve binary path: ${realpathError.message}`);
        }

        console.log(`Current version: v${currentVersion}`);

        const { data: release, error: releaseError } = await tryCatch(
            fetchLatestRelease()
        );
        if (releaseError) {
            fail(
                releaseError instanceof UpdateError
                    ? releaseError.message
                    : `Failed to check for updates: ${releaseError.message}`
            );
        }

        console.log(`Latest version:  v${release.version}`);
        console.log("");

        const cmp = compareVersions(currentVersion, release.version);
        if (cmp === 0) {
            console.log("Already up to date.");
            return;
        }
        if (cmp > 0) {
            console.log(
                "Current version is newer than the latest release. No update needed."
            );
            return;
        }

        const asset = release.assets.find((entry) => entry.name === assetName);
        if (!asset) {
            fail(`Release ${release.tag} is missing asset ${assetName}.`);
        }

        console.log(`Downloading ${assetName}...`);

        const tmpPath = `${binaryPath}.update-tmp`;
        // Clears a stale temp file; does not close the unlink-to-open window —
        // planting an entry there already requires write access to this directory.
        await removeQuietly(tmpPath);
        const { error: downloadError } = await tryCatch(
            downloadAsset(asset, tmpPath)
        );
        if (downloadError) {
            await removeQuietly(tmpPath);
            if (isPermissionError(downloadError)) {
                fail(
                    `Permission denied (${downloadError.message}). Try: sudo spanical update`
                );
            }
            fail(downloadError.message);
        }

        const verify = await verifyAssetAgainstSums(
            tmpPath,
            assetName,
            release.assets
        );
        if (!verify.ok) {
            await removeQuietly(tmpPath);
            fail(describeVerifyFailure(assetName, verify));
        }
        console.log("Verified SHA256 checksum.");

        const { error: chmodError } = await tryCatch(
            fs.chmod(tmpPath, 0o755)
        );
        if (chmodError) {
            await removeQuietly(tmpPath);
            fail(`Failed to mark binary executable: ${chmodError.message}`);
        }

        const probe = probeBinaryRuns(tmpPath);
        if (!probe.ok) {
            await removeQuietly(tmpPath);
            fail(
                `The new release v${release.version} is not runnable on this machine (${probe.reason}). Please file an issue at https://github.com/bhagyamudgal/spanical/issues.`
            );
        }

        const { error: renameError } = await tryCatch(
            fs.rename(tmpPath, binaryPath)
        );
        if (renameError) {
            await removeQuietly(tmpPath);
            if (isPermissionError(renameError)) {
                fail(
                    `Permission denied (${renameError.message}). Try: sudo spanical update`
                );
            }
            fail(`Failed to replace binary: ${renameError.message}`);
        }

        console.log("");
        console.log(`Updated! v${currentVersion} → v${release.version}`);
        console.log(`Binary: ${binaryPath}`);
    },
});
