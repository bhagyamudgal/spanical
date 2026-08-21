import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlameLines } from "./blame";
import {
    bucketDeletionsByVictim,
    captureLineDeaths,
    parseDeletedRanges,
} from "./rework";

function lineBlock(
    sha: string,
    name: string,
    email: string,
    authoredAt: number,
    content: string
): string {
    return [
        `${sha} 1 1 1`,
        `author ${name}`,
        `author-mail <${email}>`,
        `author-time ${authoredAt}`,
        "author-tz +0000",
        `committer ${name}`,
        `committer-mail <${email}>`,
        `committer-time ${authoredAt}`,
        "committer-tz +0000",
        "summary a change",
        "filename src/a.ts",
        `\t${content}`,
    ].join("\n");
}

test("parseDeletedRanges reads parent-side deletions from -U0 hunk headers", () => {
    const diff = [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 111..222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -12,3 +12,1 @@ function f() {",
        "-const a = 1;",
        "-const b = 2;",
        "-const c = 3;",
        "+const d = 4;",
        "@@ -40 +41,2 @@ function g() {",
        "-const e = 5;",
        "@@ -50,0 +53,4 @@ function h() {",
        "+const f = 6;",
    ].join("\n");

    const ranges = parseDeletedRanges(diff);

    expect(ranges).toEqual([
        { start: 12, count: 3 },
        { start: 40, count: 1 },
    ]);
});

test("parseDeletedRanges returns nothing for additions-only diffs", () => {
    const diff = ["@@ -1,0 +2,3 @@ x", "+a", "+b", "+c"].join("\n");

    expect(parseDeletedRanges(diff)).toEqual([]);
});

test("bucketDeletionsByVictim counts deleted lines per introducing commit", () => {
    const blamed = [
        {
            sha: "a".repeat(40),
            email: "one@example.com",
            name: "One",
            authoredAt: 1000,
        },
        {
            sha: "a".repeat(40),
            email: "one@example.com",
            name: "One",
            authoredAt: 1000,
        },
        {
            sha: "b".repeat(40),
            email: "two@example.com",
            name: "Two",
            authoredAt: 2000,
        },
        {
            sha: "a".repeat(40),
            email: "one@example.com",
            name: "One",
            authoredAt: 1000,
        },
    ];
    const ranges = [
        { start: 1, count: 2 },
        { start: 4, count: 1 },
    ];

    const buckets = bucketDeletionsByVictim(ranges, blamed);

    expect(buckets).toEqual([
        {
            sha: "a".repeat(40),
            email: "one@example.com",
            name: "One",
            authoredAt: 1000,
            lines: 3,
        },
    ]);
});

test("bucketDeletionsByVictim skips ranges past the end of the blamed file", () => {
    const blamed = [
        {
            sha: "a".repeat(40),
            email: "one@example.com",
            name: "One",
            authoredAt: 1000,
        },
    ];

    const buckets = bucketDeletionsByVictim([{ start: 5, count: 3 }], blamed);

    expect(buckets).toEqual([]);
});

test("parseBlameLines keeps per-line victim identity in file order", () => {
    const shaOne = "1".repeat(40);
    const shaTwo = "2".repeat(40);
    const output = [
        lineBlock(shaOne, "One", "one@example.com", 111, "first"),
        lineBlock(shaTwo, "Two", "two@example.com", 222, "second"),
    ].join("\n");

    const lines = parseBlameLines(output);

    expect(lines).toEqual([
        {
            sha: shaOne,
            email: "one@example.com",
            name: "One",
            authoredAt: 111,
        },
        {
            sha: shaTwo,
            email: "two@example.com",
            name: "Two",
            authoredAt: 222,
        },
    ]);
});

// Runs against real git so the diff-to-blame seam is exercised without the
// scc gate the CLI-level e2e carries.
test("captureLineDeaths attributes deletions against a real fixture repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "spanical-rework-capture-"));
    function git(args: string[]): void {
        const result = Bun.spawnSync(["git", ...args], { cwd: repo });
        if (result.exitCode !== 0) {
            throw new Error(
                `git ${args.join(" ")} failed: ${result.stderr.toString()}`
            );
        }
    }
    try {
        git(["init", "-q", "-b", "main"]);
        git(["config", "user.name", "ci"]);
        git(["config", "user.email", "ci@example.com"]);
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src/a.ts"), "one\ntwo\nthree\nfour\nfive\n");
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "feat: five lines",
            "--author=dev-one <dev-one@example.com>",
        ]);
        writeFileSync(join(repo, "src/a.ts"), "one\ntwo\nsix\n");
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "refactor: trim",
            "--author=dev-two <dev-two@example.com>",
        ]);
        const log = Bun.spawnSync(["git", "log", "--format=%H", "--reverse"], {
            cwd: repo,
        })
            .stdout.toString()
            .trim()
            .split("\n");
        const victimSha = log[0];
        const killerSha = log[1];
        if (!victimSha || !killerSha) {
            throw new Error("Expected two commits in the fixture repo");
        }

        const capture = await captureLineDeaths({
            repoName: "web-app",
            repoPath: repo,
            candidates: [{ sha: killerSha, path: "src/a.ts" }],
            resolveAuthorId: (email) =>
                email === "dev-one@example.com" ? 1 : 2,
        });
        expect(capture.failedCandidates).toBe(0);
        expect(capture.records).toHaveLength(1);
        const stored = capture.records[0];
        if (!stored) {
            throw new Error("Expected one capture record");
        }
        expect(stored).toEqual({
            repo: "web-app",
            sha: killerSha,
            path: "src/a.ts",
            victimSha,
            victimAuthorId: 1,
            lines: 3,
            victimAuthoredAt: stored.victimAuthoredAt,
        });
        // Blame author-time seconds converted to cache milliseconds.
        expect(stored.victimAuthoredAt).toBeGreaterThan(1_000_000_000_000);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
