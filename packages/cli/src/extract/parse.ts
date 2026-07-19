import type { ParsedCoAuthor, ParsedCommit, ParsedFileChange } from "./types";

export const RECORD_SEPARATOR = "\x1e";
export const FIELD_SEPARATOR = "\x1f";
export const BODY_END = "\x1d";

export const GIT_LOG_FORMAT = "%x1e%H%x1f%ae%x1f%an%x1f%aI%x1f%B%x1d";

const NUMSTAT_DELIMITER = "\t";
const BINARY_MARKER = "-";
const RENAME_ARROW = " => ";
const BRACE_OPEN = "{";
const BRACE_CLOSE = "}";
const DECIMAL_RADIX = 10;
const CO_AUTHOR_TRAILER = /^co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;
const REPEATED_SLASH = /\/{2,}/g;

export function parseCoAuthorTrailers(body: string): ParsedCoAuthor[] {
    const coAuthors: ParsedCoAuthor[] = [];
    for (const match of body.matchAll(CO_AUTHOR_TRAILER)) {
        const name = match[1]?.trim();
        const email = match[2]?.trim();
        if (name !== undefined && email !== undefined) {
            coAuthors.push({ name, email });
        }
    }
    return coAuthors;
}

function destinationOfArrow(segment: string): string {
    const arrowIndex = segment.indexOf(RENAME_ARROW);
    if (arrowIndex === -1) {
        return segment;
    }
    return segment.slice(arrowIndex + RENAME_ARROW.length);
}

function resolveNumstatPath(pathPart: string): string {
    const braceStart = pathPart.indexOf(BRACE_OPEN);
    const braceEnd = pathPart.indexOf(BRACE_CLOSE);
    if (braceStart === -1 || braceEnd === -1 || braceEnd < braceStart) {
        return destinationOfArrow(pathPart);
    }
    const prefix = pathPart.slice(0, braceStart);
    const inner = pathPart.slice(braceStart + 1, braceEnd);
    const suffix = pathPart.slice(braceEnd + 1);
    const resolved = prefix + destinationOfArrow(inner) + suffix;
    return resolved.replace(REPEATED_SLASH, "/");
}

export function parseNumstatLine(line: string): ParsedFileChange {
    const columns = line.split(NUMSTAT_DELIMITER);
    const addedRaw = columns[0] ?? "";
    const deletedRaw = columns[1] ?? "";
    const pathPart = columns.slice(2).join(NUMSTAT_DELIMITER);
    const path = resolveNumstatPath(pathPart);

    if (addedRaw === BINARY_MARKER && deletedRaw === BINARY_MARKER) {
        return { path, added: null, deleted: null, isBinary: true };
    }

    return {
        path,
        added: Number.parseInt(addedRaw, DECIMAL_RADIX),
        deleted: Number.parseInt(deletedRaw, DECIMAL_RADIX),
        isBinary: false,
    };
}

export function parseCommitRecord(record: string): ParsedCommit {
    const [header = "", numstatBlock = ""] = record.split(BODY_END);
    const fields = header.split(FIELD_SEPARATOR);
    const sha = (fields[0] ?? "").trim();
    const authorEmail = (fields[1] ?? "").trim();
    const authorName = (fields[2] ?? "").trim();
    const authoredAtIso = (fields[3] ?? "").trim();
    const body = fields[4] ?? "";

    const files = numstatBlock
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(parseNumstatLine);

    return {
        sha,
        authorEmail,
        authorName,
        authoredAt: new Date(authoredAtIso).getTime(),
        coAuthors: parseCoAuthorTrailers(body),
        files,
    };
}

export function parseGitLog(stdout: string): ParsedCommit[] {
    return stdout
        .split(RECORD_SEPARATOR)
        .filter((chunk) => chunk.trim().length > 0)
        .map(parseCommitRecord);
}
