import { tryCatch } from "@spanical/utils";
import { runGit } from "./git";

const AUTHOR_MAIL_PREFIX = "author-mail ";
const AUTHOR_NAME_PREFIX = "author ";
const CONTENT_LINE_PREFIX = "\t";
const OPEN_BRACKET = "<";
const CLOSE_BRACKET = ">";

export type BlameTally = Map<string, { name: string; lines: number }>;

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
