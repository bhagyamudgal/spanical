import { expect, test } from "bun:test";
import {
    BODY_END,
    FIELD_SEPARATOR,
    RECORD_SEPARATOR,
    parseCoAuthorTrailers,
    parseCommitRecord,
    parseGitLog,
    parseNumstatLine,
} from "./parse";

type RecordParts = {
    sha: string;
    email: string;
    name: string;
    iso: string;
    body: string;
    numstat: string[];
};

function buildCommitRecord(parts: RecordParts): string {
    const header = [
        parts.sha,
        parts.email,
        parts.name,
        parts.iso,
        parts.body,
    ].join(FIELD_SEPARATOR);
    const numstatBlock =
        parts.numstat.length > 0 ? `\n${parts.numstat.join("\n")}\n` : "";
    return `${header}${BODY_END}${numstatBlock}`;
}

test("parseNumstatLine parses a normal added/deleted line", () => {
    expect(parseNumstatLine("10\t2\tsrc/app.ts")).toEqual({
        path: "src/app.ts",
        added: 10,
        deleted: 2,
        isBinary: false,
    });
});

test("parseNumstatLine marks a binary line with null counts", () => {
    expect(parseNumstatLine("-\t-\tassets/logo.png")).toEqual({
        path: "assets/logo.png",
        added: null,
        deleted: null,
        isBinary: true,
    });
});

test("parseNumstatLine resolves an arrow rename to its destination", () => {
    expect(parseNumstatLine("3\t1\tsrc/old.ts => src/new.ts").path).toBe(
        "src/new.ts"
    );
});

test("parseNumstatLine resolves a brace rename to its destination", () => {
    expect(parseNumstatLine("3\t1\tsrc/{old => new}/file.ts").path).toBe(
        "src/new/file.ts"
    );
});

test("parseCoAuthorTrailers returns an empty list when there are none", () => {
    expect(
        parseCoAuthorTrailers("feat: add a thing\n\nno trailers here")
    ).toEqual([]);
});

test("parseCoAuthorTrailers extracts a single co-author", () => {
    const body =
        "feat: pair work\n\nCo-authored-by: dev-two <dev-two@example.com>";
    expect(parseCoAuthorTrailers(body)).toEqual([
        { name: "dev-two", email: "dev-two@example.com" },
    ]);
});

test("parseCoAuthorTrailers extracts multiple co-authors in order", () => {
    const body = [
        "feat: mob work",
        "",
        "Co-authored-by: dev-two <dev-two@example.com>",
        "Co-authored-by: dev-three <dev-three@example.com>",
    ].join("\n");
    expect(parseCoAuthorTrailers(body)).toEqual([
        { name: "dev-two", email: "dev-two@example.com" },
        { name: "dev-three", email: "dev-three@example.com" },
    ]);
});

test("parseCommitRecord parses a normal single-file commit", () => {
    const record = buildCommitRecord({
        sha: "abc123",
        email: "dev-one@example.com",
        name: "dev-one",
        iso: "2025-07-01T12:00:00+02:00",
        body: "feat: add a feature",
        numstat: ["10\t2\tsrc/app.ts"],
    });

    const parsed = parseCommitRecord(record);

    expect(parsed.sha).toBe("abc123");
    expect(parsed.authorEmail).toBe("dev-one@example.com");
    expect(parsed.authorName).toBe("dev-one");
    expect(parsed.authoredAt).toBe(Date.UTC(2025, 6, 1, 10, 0, 0));
    expect(parsed.coAuthors).toEqual([]);
    expect(parsed.files).toEqual([
        { path: "src/app.ts", added: 10, deleted: 2, isBinary: false },
    ]);
});

test("parseCommitRecord parses every file in a multi-file commit", () => {
    const record = buildCommitRecord({
        sha: "def456",
        email: "dev-one@example.com",
        name: "dev-one",
        iso: "2025-07-01T00:00:00Z",
        body: "chore: touch several files",
        numstat: [
            "10\t2\tsrc/a.ts",
            "0\t5\tsrc/b.ts",
            "-\t-\tassets/image.png",
        ],
    });

    expect(parseCommitRecord(record).files).toEqual([
        { path: "src/a.ts", added: 10, deleted: 2, isBinary: false },
        { path: "src/b.ts", added: 0, deleted: 5, isBinary: false },
        {
            path: "assets/image.png",
            added: null,
            deleted: null,
            isBinary: true,
        },
    ]);
});

test("parseCommitRecord returns no files for an empty numstat block", () => {
    const record = buildCommitRecord({
        sha: "aaa000",
        email: "dev-one@example.com",
        name: "dev-one",
        iso: "2025-07-01T00:00:00Z",
        body: "docs: message only, no file changes",
        numstat: [],
    });

    expect(parseCommitRecord(record).files).toEqual([]);
});

test("parseCommitRecord collects co-author trailers from the body", () => {
    const record = buildCommitRecord({
        sha: "bbb111",
        email: "dev-one@example.com",
        name: "dev-one",
        iso: "2025-07-01T00:00:00Z",
        body: "feat: squashed work\n\nCo-authored-by: dev-two <dev-two@example.com>",
        numstat: ["4\t0\tsrc/feature.ts"],
    });

    expect(parseCommitRecord(record).coAuthors).toEqual([
        { name: "dev-two", email: "dev-two@example.com" },
    ]);
});

test("parseGitLog parses a two-commit stream in order", () => {
    const first = buildCommitRecord({
        sha: "sha1",
        email: "dev-one@example.com",
        name: "dev-one",
        iso: "2025-07-01T00:00:00Z",
        body: "feat: first",
        numstat: ["1\t0\tsrc/first.ts"],
    });
    const second = buildCommitRecord({
        sha: "sha2",
        email: "dev-two@example.com",
        name: "dev-two",
        iso: "2025-07-02T00:00:00Z",
        body: "feat: second",
        numstat: ["2\t1\tsrc/second.ts"],
    });
    const stdout = `${RECORD_SEPARATOR}${first}${RECORD_SEPARATOR}${second}`;

    const commits = parseGitLog(stdout);

    expect(commits).toHaveLength(2);
    expect(commits[0]?.sha).toBe("sha1");
    expect(commits[1]?.sha).toBe("sha2");
});
