import { tryCatch } from "@spanical/utils";
import { runGit } from "./git";

const AUTHOR_MAIL_PREFIX = "author-mail ";
const AUTHOR_NAME_PREFIX = "author ";
const CONTENT_LINE_PREFIX = "\t";
const OPEN_BRACKET = "<";
const CLOSE_BRACKET = ">";

export type BlameTally = Map<string, { name: string; lines: number }>;

export type BlamedLine = {
    sha: string;
    email: string;
    name: string;
    authoredAt: number;
};

// Object IDs are 40 hex (SHA-1) or 64 hex (SHA-256) repositories, optionally
// caret-prefixed for grafted-boundary commits; the full id is captured, never
// sliced, because victim_sha keys into the deaths table.
const SHA_LINE_PATTERN = /^\^?([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+/;
const AUTHOR_TIME_PREFIX = "author-time ";

// parseBlamePorcelain tallies; this one keeps per-line identity so deleted
// ranges can be attributed to the commit that introduced them.
export function parseBlameLines(output: string): BlamedLine[] {
    const lines: BlamedLine[] = [];
    let sha: string | null = null;
    let email = "";
    let name = "";
    let authoredAt = 0;

    for (const line of output.split("\n")) {
        if (line.startsWith(CONTENT_LINE_PREFIX)) {
            if (sha === null) {
                continue;
            }
            lines.push({ sha, email, name, authoredAt });
            sha = null;
            continue;
        }
        const shaMatch = SHA_LINE_PATTERN.exec(line);
        if (shaMatch?.[1] !== undefined) {
            sha = shaMatch[1];
            continue;
        }
        if (line.startsWith(AUTHOR_MAIL_PREFIX)) {
            email = stripAngleBrackets(
                line.slice(AUTHOR_MAIL_PREFIX.length).trim()
            );
            continue;
        }
        if (line.startsWith(AUTHOR_NAME_PREFIX)) {
            name = line.slice(AUTHOR_NAME_PREFIX.length).trim();
            continue;
        }
        if (line.startsWith(AUTHOR_TIME_PREFIX)) {
            authoredAt = Number.parseInt(
                line.slice(AUTHOR_TIME_PREFIX.length).trim(),
                10
            );
        }
    }

    return lines;
}

export async function blameFileLines(
    repoPath: string,
    ref: string,
    path: string
): Promise<BlamedLine[] | null> {
    // Line lifetimes must survive moves and copies: without -M -C, blame
    // resets moved lines to the moving commit and later deletions charge the
    // mover instead of the original author. Ownership's tally blame stays
    // default on purpose; only this parser follows origin.
    const { data, error } = await tryCatch(
        runGit(
            ["blame", "--line-porcelain", "-M", "-C", ref, "--", path],
            repoPath
        )
    );
    if (error) {
        return null;
    }
    return parseBlameLines(data);
}

function stripAngleBrackets(value: string): string {
    const withoutOpen = value.startsWith(OPEN_BRACKET) ? value.slice(1) : value;
    return withoutOpen.endsWith(CLOSE_BRACKET)
        ? withoutOpen.slice(0, -1)
        : withoutOpen;
}

export function parseBlamePorcelain(output: string): BlameTally {
    const tally: BlameTally = new Map();
    let currentEmail: string | null = null;
    let currentName = "";

    for (const line of output.split("\n")) {
        if (line.startsWith(CONTENT_LINE_PREFIX)) {
            if (currentEmail === null) {
                continue;
            }
            const existing = tally.get(currentEmail);
            if (existing) {
                existing.lines += 1;
            } else {
                tally.set(currentEmail, { name: currentName, lines: 1 });
            }
            continue;
        }
        if (line.startsWith(AUTHOR_MAIL_PREFIX)) {
            currentEmail = stripAngleBrackets(
                line.slice(AUTHOR_MAIL_PREFIX.length).trim()
            );
            continue;
        }
        if (line.startsWith(AUTHOR_NAME_PREFIX)) {
            currentName = line.slice(AUTHOR_NAME_PREFIX.length).trim();
        }
    }

    return tally;
}

export async function blameFile(
    repoPath: string,
    ref: string,
    path: string
): Promise<BlameTally | null> {
    const { data, error } = await tryCatch(
        runGit(["blame", "--line-porcelain", ref, "--", path], repoPath)
    );
    if (error) {
        return null;
    }
    return parseBlamePorcelain(data);
}
