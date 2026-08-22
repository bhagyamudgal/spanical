import fs from "node:fs";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import { tryCatch, tryCatchSync } from "@spanical/utils";
import pkg from "../../package.json";
import { UPDATE_ERROR_CODES, UpdateError, errorCode } from "./errors";
import { parseSha256Sums } from "./sums";

const REPO = "bhagyamudgal/spanical";
const API_RELEASES_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

// Host-pin fetches to GitHub origins; defense-in-depth against CDN/release-asset compromise.
const ALLOWED_RELEASE_HOSTS = new Set([
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
]);

export function isAllowedReleaseHost(urlString: string): boolean {
    const { data: parsed } = tryCatchSync(() => new URL(urlString));
    if (!parsed) return false;
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_RELEASE_HOSTS.has(parsed.host);
}

const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

// GITHUB_TOKEN bumps the rate limit from 60/hr to 5000/hr when present.
function buildGitHubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        "User-Agent": `spanical/${pkg.version}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    const token = process.env.GITHUB_TOKEN;
    if (token && token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
    }
    return headers;
}

const DEFAULT_META_TIMEOUT_MS = 30_000;
const DEFAULT_ASSET_TIMEOUT_MS = 600_000;
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;

export type ReleaseAsset = {
    name: string;
    browser_download_url: string;
};

export type ReleaseInfo = {
    tag: string;
    version: string;
    assets: ReleaseAsset[];
};

export function isStandalone(): boolean {
    return (
        Bun.main.startsWith("/$bunfs/") || import.meta.url.includes("$bunfs/")
    );
}

export function getAssetName(
    platform: string = process.platform,
    arch: string = process.arch
): string | null {
    if (platform !== "darwin" && platform !== "linux") return null;
    if (arch !== "arm64" && arch !== "x64") return null;
    return `spanical-${platform}-${arch}`;
}

function isReleaseInfo(value: unknown): value is {
    tag_name: string;
    assets: ReleaseAsset[];
} {
    // Unknown JSON boundary; record-narrowing needs the assertions.
    if (!value || typeof value !== "object") return false;
    const rec = value as Record<string, unknown>;
    if (typeof rec.tag_name !== "string") return false;
    if (!Array.isArray(rec.assets)) return false;
    return rec.assets.every((entry: unknown) => {
        if (!entry || typeof entry !== "object") return false;
        const asset = entry as Record<string, unknown>;
        return (
            typeof asset.name === "string" &&
            typeof asset.browser_download_url === "string"
        );
    });
}

async function withTimeout<T>(
    url: string,
    timeoutMs: number,
    handler: (response: Response) => Promise<T>
): Promise<T> {
    if (!isAllowedReleaseHost(url)) {
        throw new UpdateError(
            UPDATE_ERROR_CODES.DOWNLOAD_FAILED,
            `Refused to fetch URL with disallowed host: ${JSON.stringify(url.slice(0, 120))}`
        );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // Follow redirects manually so each hop's host is validated BEFORE we connect to it —
        // default `redirect: "follow"` connects to intermediate hosts and only exposes the final URL.
        const originHost = new URL(url).host;
        let currentUrl = url;
        // Once Authorization has been stripped on any cross-origin hop, never re-add —
        // prevents a redirect chain that bounces back to the origin host from re-attaching the token.
        let authStripped = false;
        for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
            const headers = buildGitHubHeaders();
            if (authStripped || new URL(currentUrl).host !== originHost) {
                delete headers.Authorization;
                authStripped = true;
            }
            const response = await fetch(currentUrl, {
                signal: controller.signal,
                headers,
                redirect: "manual",
            });
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");
                await tryCatch(response.body?.cancel() ?? Promise.resolve());
                if (!location) {
                    throw new UpdateError(
                        UPDATE_ERROR_CODES.DOWNLOAD_FAILED,
                        `Redirect ${response.status} without Location header from ${new URL(currentUrl).host}`
                    );
                }
                const next = new URL(location, currentUrl).toString();
                if (!isAllowedReleaseHost(next)) {
                    throw new UpdateError(
                        UPDATE_ERROR_CODES.DOWNLOAD_FAILED,
                        `Refused redirect to disallowed host: ${new URL(next).host}`
                    );
                }
                currentUrl = next;
                continue;
            }
            return await handler(response);
        }
        throw new UpdateError(
            UPDATE_ERROR_CODES.DOWNLOAD_FAILED,
            `Exceeded ${MAX_REDIRECT_HOPS} redirects from ${new URL(url).host}`
        );
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchLatestRelease(
    timeoutMs: number = DEFAULT_META_TIMEOUT_MS
): Promise<ReleaseInfo> {
    const { data: result, error } = await tryCatch(
        withTimeout(API_RELEASES_LATEST, timeoutMs, async (response) => {
            if (!response.ok) {
                throw new UpdateError(
                    UPDATE_ERROR_CODES.CHECK_FAILED,
                    `GitHub API error: ${response.status} ${response.statusText}`
                );
            }
            const json: unknown = await response.json();
            if (!isReleaseInfo(json)) {
                throw new UpdateError(
                    UPDATE_ERROR_CODES.CHECK_FAILED,
                    "Release payload missing tag_name or assets"
                );
            }
            // Reject malformed tags at the boundary so they can't propagate into paths/logs.
            if (!RELEASE_TAG_PATTERN.test(json.tag_name)) {
                throw new UpdateError(
                    UPDATE_ERROR_CODES.CHECK_FAILED,
                    `Release tag malformed: ${JSON.stringify(json.tag_name.slice(0, 40))}`
                );
            }
            return {
                tag: json.tag_name,
                version: json.tag_name.replace(/^v/, ""),
                assets: json.assets,
            };
        })
    );
    if (error || !result) {
        if (error instanceof UpdateError) throw error;
        throw new UpdateError(
            UPDATE_ERROR_CODES.CHECK_FAILED,
            `Failed to reach GitHub releases API: ${error?.message ?? "unknown"}`,
            { cause: error ?? undefined }
        );
    }
    return result;
}

export async function downloadAsset(
    asset: ReleaseAsset,
    destPath: string,
    timeoutMs: number = DEFAULT_ASSET_TIMEOUT_MS
): Promise<void> {
    const { error } = await tryCatch(
        withTimeout(asset.browser_download_url, timeoutMs, async (response) => {
            if (!response.ok) {
                throw new Error(
                    `Download ${asset.name} failed: ${response.status} ${response.statusText}`
                );
            }
            const contentLength = response.headers.get("content-length");
            let declaredBytes: number | null = null;
            if (contentLength !== null) {
                const declared = Number(contentLength);
                if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
                    throw new Error(
                        `Download ${asset.name} refused: declared size ${declared} bytes exceeds cap ${MAX_ASSET_BYTES} bytes`
                    );
                }
                if (Number.isFinite(declared)) declaredBytes = declared;
            }
            if (!response.body) {
                throw new Error(
                    `Download ${asset.name} refused: empty response body`
                );
            }
            const reader = response.body.getReader();
            const writer = fs.createWriteStream(destPath, { flags: "w" });
            // Write/open failures (EACCES, ENOSPC, EIO) arrive on this event, not
            // as write() return values; without a listener Bun kills the process.
            const writerFailure = new Promise<never>((_, reject) => {
                writer.once("error", reject);
            });
            writerFailure.catch(() => {});
            let bytesReceived = 0;
            let writerClosed = false;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value) continue;
                    bytesReceived += value.byteLength;
                    if (bytesReceived > MAX_ASSET_BYTES) {
                        throw new Error(
                            `Download ${asset.name} exceeded cap: ${bytesReceived} bytes > ${MAX_ASSET_BYTES} bytes`
                        );
                    }
                    if (!writer.write(value)) {
                        await Promise.race([
                            once(writer, "drain"),
                            writerFailure,
                        ]);
                    }
                }
                if (bytesReceived === 0) {
                    throw new Error(
                        `Download ${asset.name} refused: empty response body`
                    );
                }
                if (declaredBytes !== null && bytesReceived !== declaredBytes) {
                    throw new Error(
                        `Download ${asset.name} truncated: received ${bytesReceived} bytes, expected ${declaredBytes}`
                    );
                }
                await Promise.race([
                    new Promise<void>((resolve, reject) => {
                        writer.end((err: NodeJS.ErrnoException | null) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    }),
                    writerFailure,
                ]);
                writerClosed = true;
            } finally {
                tryCatchSync(() => reader.releaseLock());
                if (!writerClosed) {
                    writer.destroy();
                }
            }
        })
    );
    if (error) {
        const { error: cleanupError } = tryCatchSync(() =>
            fs.unlinkSync(destPath)
        );
        const hasCleanupFailure =
            cleanupError && errorCode(cleanupError) !== "ENOENT";
        const cleanupNote = hasCleanupFailure
            ? ` (cleanup of partial file also failed: ${cleanupError.message})`
            : "";
        throw new UpdateError(
            UPDATE_ERROR_CODES.DOWNLOAD_FAILED,
            `Failed to download ${asset.name}${cleanupNote}: ${error.message}`,
            { cause: error }
        );
    }
}

type HashResult =
    | { ok: true; hash: string }
    | { ok: false; kind: "mismatch" }
    | { ok: false; kind: "io-error"; cause: Error };

async function computeSha256(filePath: string): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    const file = Bun.file(filePath);
    for await (const chunk of file.stream()) {
        hasher.update(chunk);
    }
    return hasher.digest("hex").toLowerCase();
}

async function verifyBinaryHash(
    filePath: string,
    expectedSha256: string
): Promise<HashResult> {
    const { data: actual, error } = await tryCatch(computeSha256(filePath));
    if (error) return { ok: false, kind: "io-error", cause: error };
    if (constantTimeEquals(actual, expectedSha256.toLowerCase())) {
        return { ok: true, hash: expectedSha256.toLowerCase() };
    }
    return { ok: false, kind: "mismatch" };
}

function constantTimeEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

type Sha256SumsResult =
    | { kind: "ok"; sums: Record<string, string> }
    | { kind: "error"; reason: string };

async function fetchSha256Sums(
    assets: ReleaseAsset[],
    timeoutMs: number = DEFAULT_META_TIMEOUT_MS
): Promise<Sha256SumsResult> {
    const sumsAsset = assets.find((entry) => entry.name === "SHA256SUMS");
    if (!sumsAsset) {
        // The release pipeline always publishes SHA256SUMS; absence means the
        // release is broken or tampered with, so refuse rather than verify-fail-open.
        return {
            kind: "error",
            reason: "no SHA256SUMS asset published for this release",
        };
    }
    const { data: result, error } = await tryCatch(
        withTimeout(
            sumsAsset.browser_download_url,
            timeoutMs,
            async (response): Promise<Sha256SumsResult> => {
                if (!response.ok) {
                    return {
                        kind: "error",
                        reason: `${response.status} ${response.statusText}`,
                    };
                }
                const text = await response.text();
                if (!text) {
                    return { kind: "error", reason: "empty SHA256SUMS body" };
                }
                // Duplicate entries are tampering, not transient — permanent failure.
                const { data: parsed, error: parseError } = tryCatchSync(() =>
                    parseSha256Sums(text)
                );
                if (parseError || !parsed) {
                    return {
                        kind: "error",
                        reason:
                            parseError?.message ??
                            "malformed SHA256SUMS (duplicate entries)",
                    };
                }
                return { kind: "ok", sums: parsed };
            }
        )
    );
    if (error || !result) {
        return { kind: "error", reason: error?.message ?? "network error" };
    }
    return result;
}

export type VerifyAssetResult =
    | { ok: true; hash: string }
    | { ok: false; kind: "sums-error"; reason: string }
    | { ok: false; kind: "missing-entry" }
    | { ok: false; kind: "hash-io-error"; cause: Error }
    | { ok: false; kind: "hash-mismatch" };

export async function verifyAssetAgainstSums(
    tmpPath: string,
    assetName: string,
    assets: ReleaseAsset[]
): Promise<VerifyAssetResult> {
    const sums = await fetchSha256Sums(assets);
    if (sums.kind === "error") {
        return { ok: false, kind: "sums-error", reason: sums.reason };
    }
    const expected = sums.sums[assetName];
    if (!expected) {
        return { ok: false, kind: "missing-entry" };
    }
    const hashResult = await verifyBinaryHash(tmpPath, expected);
    if (!hashResult.ok) {
        if (hashResult.kind === "io-error") {
            return {
                ok: false,
                kind: "hash-io-error",
                cause: hashResult.cause,
            };
        }
        return { ok: false, kind: "hash-mismatch" };
    }
    return { ok: true, hash: hashResult.hash };
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

const PROBE_TIMEOUT_MS = 2_000;
const PROBE_VERSION_PATTERN = /\d+\.\d+\.\d+/;

// Probe before rename — SHA match ≠ runnable; segfaults on libc/codesign mismatch.
export function probeBinaryRuns(filePath: string): ProbeResult {
    const startedAt = Date.now();
    const { data: result, error } = tryCatchSync(() =>
        Bun.spawnSync({
            cmd: [filePath, "--version"],
            stdout: "pipe",
            stderr: "pipe",
            timeout: PROBE_TIMEOUT_MS,
        })
    );
    if (error || !result) {
        return { ok: false, reason: error?.message ?? "spawn failed" };
    }
    // Bun reports SIGTERM with a null exitCode both for its own timeout kill and
    // an external kill, so only elapsed wall-clock can tell them apart.
    if (result.exitCode === null) {
        const timedOut =
            result.signalCode !== null &&
            Date.now() - startedAt >= PROBE_TIMEOUT_MS;
        return {
            ok: false,
            reason: timedOut
                ? `timed out after ${PROBE_TIMEOUT_MS}ms`
                : `terminated by signal ${result.signalCode ?? "unknown"}`,
        };
    }
    if (result.exitCode !== 0) {
        const stderr = decodeProbeStream(result.stderr);
        const base = `exit ${result.exitCode}`;
        return { ok: false, reason: stderr ? `${base}: ${stderr}` : base };
    }
    const stdout = decodeProbeStream(result.stdout);
    if (!PROBE_VERSION_PATTERN.test(stdout)) {
        const truncated = stdout.slice(0, 80);
        return {
            ok: false,
            reason: `version output did not match expected format: ${JSON.stringify(truncated)}`,
        };
    }
    return { ok: true };
}

function decodeProbeStream(stream: unknown): string {
    if (!(stream instanceof Uint8Array)) {
        return `<probe stream type=${typeof stream}>`;
    }
    const truncated = stream.slice(0, 500);
    return new TextDecoder().decode(truncated).trim();
}
