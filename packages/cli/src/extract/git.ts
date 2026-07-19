import { tryCatch } from "@spanical/utils";
import { EXTRACT_ERROR_CODES, ExtractError } from "./errors";
import { GIT_LOG_FORMAT, RECORD_SEPARATOR, parseCommitRecord } from "./parse";
import type { ParsedCommit } from "./types";

const ORIGIN_PREFIX = "origin/";
const DEFAULT_BRANCH_CANDIDATES = ["main", "master"] as const;
const SHALLOW_MARKER = "shallow";

export function assertGitAvailable(): void {
    if (!Bun.which("git")) {
        throw new ExtractError(
            EXTRACT_ERROR_CODES.GIT_NOT_FOUND,
            "git was not found on PATH. Install git from https://git-scm.com/downloads and try again."
        );
    }
}

export async function runGit(args: string[], cwd: string): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        throw new ExtractError(
            EXTRACT_ERROR_CODES.GIT_COMMAND_FAILED,
            `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`
        );
    }
    return stdout;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
    const { error } = await tryCatch(
        runGit(["rev-parse", "--verify", "--quiet", ref], cwd)
    );
    return error === null;
}

export async function resolveDefaultBranch(
    cwd: string,
    override?: string
): Promise<string> {
    if (override !== undefined) {
        if (await refExists(cwd, override)) {
            return override;
        }
        throw new ExtractError(
            EXTRACT_ERROR_CODES.BRANCH_UNRESOLVED,
            `Configured branch "${override}" was not found in ${cwd}.`
        );
    }

    const { data: originHead } = await tryCatch(
        runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)
    );
    if (originHead) {
        const trimmed = originHead.trim();
        const branch = trimmed.startsWith(ORIGIN_PREFIX)
            ? trimmed.slice(ORIGIN_PREFIX.length)
            : trimmed;
        if (branch.length > 0) {
            return branch;
        }
    }

    for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
        if (await refExists(cwd, candidate)) {
            return candidate;
        }
    }

    throw new ExtractError(
        EXTRACT_ERROR_CODES.BRANCH_UNRESOLVED,
        `Could not resolve a default branch in ${cwd}. Set repo.branch in your config.`
    );
}

export async function getBranchTipSha(
    cwd: string,
    branch: string
): Promise<string> {
    const stdout = await runGit(["rev-parse", branch], cwd);
    return stdout.trim();
}

export async function* streamGitLog(
    cwd: string,
    branch: string,
    since?: string
): AsyncGenerator<ParsedCommit> {
    const args = [
        "log",
        branch,
        "--no-merges",
        "--numstat",
        "-M",
        "-C",
        `--pretty=format:${GIT_LOG_FORMAT}`,
    ];
    if (since !== undefined) {
        args.push(`--since=${since}`);
    }

    const proc = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        const records = buffer.split(RECORD_SEPARATOR);
        buffer = records.pop() ?? "";
        for (const record of records) {
            if (record.trim().length > 0) {
                yield parseCommitRecord(record);
            }
        }
    }
    buffer += decoder.decode();

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        if (stderr.toLowerCase().includes(SHALLOW_MARKER)) {
            throw new ExtractError(
                EXTRACT_ERROR_CODES.SHALLOW_HISTORY,
                `Cannot extract from a shallow clone in ${cwd}. Run "git fetch --unshallow" first.`
            );
        }
        throw new ExtractError(
            EXTRACT_ERROR_CODES.GIT_COMMAND_FAILED,
            `git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`
        );
    }

    if (buffer.trim().length > 0) {
        yield parseCommitRecord(buffer);
    }
}
