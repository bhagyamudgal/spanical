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

test("parseBlameLines captures full SHA-256 object ids without truncation", () => {
    const sha256 = "a".repeat(64);
    const output = lineBlock(sha256, "One", "one@example.com", 111, "first");

    const lines = parseBlameLines(output);

    expect(lines).toEqual([
        {
            sha: sha256,
            email: "one@example.com",
            name: "One",
            authoredAt: 111,
        },
    ]);
});

test("parseBlameLines strips the caret prefix of grafted-boundary commits", () => {
    const boundarySha = "b".repeat(40);
    const output = [
        `^${boundarySha} 1 1 1`,
        "author One",
        "author-mail <one@example.com>",
        "author-time 111",
        "author-tz +0000",
        "\tboundary line",
    ].join("\n");

    const lines = parseBlameLines(output);

    expect(lines).toEqual([
        {
            sha: boundarySha,
            email: "one@example.com",
            name: "One",
            authoredAt: 111,
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

test("captureLineDeaths still parses hunks when color.ui forces ANSI output", async () => {
    const repo = mkdtempSync(join(tmpdir(), "spanical-rework-color-"));
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
        // color.ui=always emits ANSI bytes even into pipes; a machine parser
        // that inherits it sees hunk headers it can never match.
        git(["config", "color.ui", "always"]);
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
        const shas = Bun.spawnSync(["git", "log", "--format=%H", "--reverse"], {
            cwd: repo,
        })
            .stdout.toString()
            .trim()
            .split("\n");
        const victimSha = shas[0];
        const killerSha = shas[1];
        if (!victimSha || !killerSha) {
            throw new Error("Expected two commits in the fixture repo");
        }

        const capture = await captureLineDeaths({
            repoName: "web-app",
            repoPath: repo,
            candidates: [{ sha: killerSha, path: "src/a.ts" }],
            resolveAuthorId: () => 1,
        });

        expect(capture.failedCandidates).toBe(0);
        expect(capture.records).toHaveLength(1);
        expect(capture.records[0]?.lines).toBe(3);
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("captureLineDeaths keeps the original author across a move", async () => {
    const repo = mkdtempSync(join(tmpdir(), "spanical-rework-move-"));
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
        mkdirSync(join(repo, "notes"), { recursive: true });
        writeFileSync(join(repo, "notes/old.txt"), "keep-a\nkill-b\nkill-c\n");
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "feat: notes",
            "--author=dev-one <dev-one@example.com>",
        ]);
        git(["mv", "notes/old.txt", "notes/new.txt"]);
        git([
            "commit",
            "-q",
            "-m",
            "chore: move notes",
            "--author=dev-two <dev-two@example.com>",
        ]);
        writeFileSync(join(repo, "notes/new.txt"), "keep-a\nnew-line\n");
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "refactor: trim moved notes",
            "--author=dev-two <dev-two@example.com>",
        ]);
        const shas = Bun.spawnSync(
            ["git", "log", "--format=%H %ae", "--reverse"],
            {
                cwd: repo,
            }
        )
            .stdout.toString()
            .trim()
            .split("\n")
            .map((line) => line.split(" "));
        const original = { sha: shas[0]?.[0], email: shas[0]?.[1] };
        const moverSha = shas[1]?.[0];
        const killerSha = shas[2]?.[0];
        if (!original?.sha || !original.email || !moverSha || !killerSha) {
            throw new Error("Expected three commits in the fixture repo");
        }

        const capture = await captureLineDeaths({
            repoName: "web-app",
            repoPath: repo,
            candidates: [{ sha: killerSha, path: "notes/new.txt" }],
            resolveAuthorId: (email) => (email === original.email ? 7 : 9),
        });

        // Without -M -C the mover would be charged for lines they never wrote.
        expect(capture.failedCandidates).toBe(0);
        expect(capture.records).toHaveLength(1);
        expect(capture.records[0]).toMatchObject({
            victimSha: original.sha,
            victimAuthorId: 7,
            lines: 2,
        });
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("captureLineDeaths keeps the original author across an intra-file move", async () => {
    const repo = mkdtempSync(join(tmpdir(), "spanical-rework-intramove-"));
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
        writeFileSync(
            join(repo, "f.txt"),
            "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\n"
        );
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "feat: six lines",
            "--author=dev-one <dev-one@example.com>",
        ]);
        // dev-two moves the last three lines above the first three.
        writeFileSync(
            join(repo, "f.txt"),
            "delta\necho\nfoxtrot\nalpha\nbravo\ncharlie\n"
        );
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "refactor: reorder",
            "--author=dev-two <dev-two@example.com>",
        ]);
        // Then deletes all three moved lines.
        writeFileSync(join(repo, "f.txt"), "alpha\nbravo\ncharlie\n");
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "refactor: drop moved lines",
            "--author=dev-two <dev-two@example.com>",
        ]);
        const shas = Bun.spawnSync(["git", "log", "--format=%H", "--reverse"], {
            cwd: repo,
        })
            .stdout.toString()
            .trim()
            .split("\n");
        const originalSha = shas[0];
        const killerSha = shas[2];
        if (!originalSha || !killerSha) {
            throw new Error("Expected three commits in the fixture repo");
        }

        const capture = await captureLineDeaths({
            repoName: "web-app",
            repoPath: repo,
            candidates: [{ sha: killerSha, path: "f.txt" }],
            resolveAuthorId: (email) =>
                email === "dev-one@example.com" ? 7 : 9,
        });

        expect(capture.failedCandidates).toBe(0);
        expect(capture.records).toHaveLength(1);
        expect(capture.records[0]).toMatchObject({
            victimSha: originalSha,
            victimAuthorId: 7,
            lines: 3,
        });
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});

test("captureLineDeaths keeps the original author across a cross-file copy", async () => {
    const repo = mkdtempSync(join(tmpdir(), "spanical-rework-copy-"));
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
        const copied =
            "unique-shared-line-one-with-enough-context-for-copy-detection\nunique-shared-line-two-with-enough-context-for-copy-detection\n";
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src/a.txt"), `${copied}a-only-line\n`);
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "feat: source lines",
            "--author=dev-one <dev-one@example.com>",
        ]);
        // dev-two extracts the shared lines into b.txt while trimming them
        // out of a.txt in the SAME commit: blame can only trace a copy whose
        // commit also touched the source file.
        writeFileSync(join(repo, "src/a.txt"), "a-only-line\n");
        writeFileSync(join(repo, "src/b.txt"), `b-own-line\n${copied}`);
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "refactor: extract shared lines",
            "--author=dev-two <dev-two@example.com>",
        ]);
        // Later dev-two deletes the extracted lines from b.txt again; the
        // origin must stay dev-one's original commit.
        writeFileSync(join(repo, "src/b.txt"), "b-own-line\n");
        git(["add", "-A"]);
        git([
            "commit",
            "-q",
            "-m",
            "refactor: drop copied lines",
            "--author=dev-two <dev-two@example.com>",
        ]);
        const shas = Bun.spawnSync(["git", "log", "--format=%H", "--reverse"], {
            cwd: repo,
        })
            .stdout.toString()
            .trim()
            .split("\n");
        const originalSha = shas[0];
        const killerSha = shas[2];
        if (!originalSha || !killerSha) {
            throw new Error("Expected three commits in the fixture repo");
        }

        const capture = await captureLineDeaths({
            repoName: "web-app",
            repoPath: repo,
            candidates: [{ sha: killerSha, path: "src/b.txt" }],
            resolveAuthorId: (email) =>
                email === "dev-one@example.com" ? 7 : 9,
        });

        expect(capture.failedCandidates).toBe(0);
        expect(capture.records).toHaveLength(1);
        expect(capture.records[0]).toMatchObject({
            victimSha: originalSha,
            victimAuthorId: 7,
            lines: 2,
        });
    } finally {
        rmSync(repo, { recursive: true, force: true });
    }
});
