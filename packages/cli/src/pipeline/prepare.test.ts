import { eq } from "drizzle-orm";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCache } from "../cache/open";
import {
    commits,
    extractions,
    fileChanges,
    lineDeaths,
    reworkCaptures,
} from "../cache/schema";
import { configSchema } from "../config/schema";
import type { LineDeathRecord } from "../extract/rework";
import { ensureRework } from "./prepare";

function seedFixture(): { handle: ReturnType<typeof openCache>; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "spanical-prepare-"));
    const handle = openCache({ cwd: dir });
    const { db } = handle;

    db.insert(extractions)
        .values({
            repo: "web-app",
            branch: "main",
            tipSha: "tip",
            since: null,
            configKey: "k",
            extractedAt: 0,
        })
        .run();
    db.insert(commits)
        .values([
            {
                sha: "c1",
                repo: "web-app",
                authorId: 1,
                authoredAt: 0,
                isMerge: false,
            },
        ])
        .run();
    db.insert(fileChanges)
        .values({
            sha: "c1",
            repo: "web-app",
            path: "src/a.ts",
            added: 5,
            deleted: 3,
            isBinary: false,
            isMigration: false,
        })
        .run();

    return { handle, dir };
}

const CONFIG = configSchema.parse({
    repos: [{ name: "web-app", path: "/tmp/nowhere" }],
    authors: { "dev-one": { emails: ["dev-one@example.com"] } },
});

const RUN = { repos: [{ name: "web-app", path: "/tmp/nowhere" }] };

function deathRecord(sha: string): LineDeathRecord & { repo: string } {
    return {
        repo: "web-app",
        sha,
        path: "src/a.ts",
        victimSha: "v1",
        victimAuthorId: 1,
        victimAuthoredAt: 0,
        lines: 3,
    };
}

test("ensureRework retries a partial capture and skips a complete one", async () => {
    const { handle, dir } = seedFixture();
    try {
        const { db } = handle;
        const calls: number[] = [];
        const capture = async (opts: {
            candidates: unknown[];
            resolveAuthorId: (email: string, name: string) => number;
        }): Promise<{
            records: (LineDeathRecord & { repo: string })[];
            failedCandidates: number;
        }> => {
            calls.push(opts.candidates.length);
            // Mint a provisional author the way the real capture would, so
            // the outcome's unknownEmails has something to carry.
            opts.resolveAuthorId("stranger@example.com", "Stranger");
            if (calls.length === 1) {
                return {
                    records: [deathRecord("c1")],
                    failedCandidates: 1,
                };
            }
            return { records: [deathRecord("c1")], failedCandidates: 0 };
        };

        const partial = await ensureRework(db, RUN, CONFIG, {
            captureLineDeaths: capture,
        });
        expect(calls).toEqual([1]);
        expect(partial.incompleteRepos).toEqual(["web-app"]);
        expect(partial.unknownEmails).toContain("stranger@example.com");
        const partialMarker = db
            .select()
            .from(reworkCaptures)
            .where(eq(reworkCaptures.repo, "web-app"))
            .get();
        expect(partialMarker?.failedCandidates).toBe(1);
        expect(countDeaths(db)).toBe(1);

        const complete = await ensureRework(db, RUN, CONFIG, {
            captureLineDeaths: capture,
        });
        expect(calls).toEqual([1, 1]);
        expect(complete.incompleteRepos).toEqual([]);
        const completeMarker = db
            .select()
            .from(reworkCaptures)
            .where(eq(reworkCaptures.repo, "web-app"))
            .get();
        expect(completeMarker?.failedCandidates).toBe(0);
        // Conflict-safe inserts keep the retry from doubling rows.
        expect(countDeaths(db)).toBe(1);

        await ensureRework(db, RUN, CONFIG, { captureLineDeaths: capture });
        expect(calls).toEqual([1, 1]);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("ensureRework records an empty capture for repos with no candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spanical-prepare-empty-"));
    const handle = openCache({ cwd: dir });
    try {
        const { db } = handle;
        db.insert(extractions)
            .values({
                repo: "web-app",
                branch: "main",
                tipSha: "tip",
                since: null,
                configKey: "k",
                extractedAt: 0,
            })
            .run();
        let captureCalls = 0;
        await ensureRework(db, RUN, CONFIG, {
            captureLineDeaths: async () => {
                captureCalls += 1;
                return { records: [], failedCandidates: 0 };
            },
        });

        expect(captureCalls).toBe(0);
        const marker = db
            .select()
            .from(reworkCaptures)
            .where(eq(reworkCaptures.repo, "web-app"))
            .get();
        expect(marker?.failedCandidates).toBe(0);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

function countDeaths(db: ReturnType<typeof openCache>["db"]): number {
    return db.select({ sha: lineDeaths.sha }).from(lineDeaths).all().length;
}

test("ensureRework pages candidates through the keyset and completes after the last page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spanical-prepare-pages-"));
    const handle = openCache({ cwd: dir });
    try {
        const { db } = handle;
        db.insert(extractions)
            .values({
                repo: "web-app",
                branch: "main",
                tipSha: "tip",
                since: null,
                configKey: "k",
                extractedAt: 0,
            })
            .run();
        // One past the page size forces a second keyset page of one row.
        db.insert(fileChanges)
            .values(
                Array.from({ length: 501 }, (_, index) => ({
                    sha: `k${String(index).padStart(3, "0")}`,
                    repo: "web-app",
                    path: `/f${index}.ts`,
                    added: 10,
                    deleted: 5,
                    isBinary: false,
                    isMigration: false,
                }))
            )
            .run();

        const calls: number[] = [];
        await ensureRework(db, RUN, CONFIG, {
            captureLineDeaths: async (opts) => {
                calls.push(opts.candidates.length);
                return { records: [], failedCandidates: 0 };
            },
        });

        expect(calls).toEqual([500, 1]);
        const marker = db
            .select()
            .from(reworkCaptures)
            .where(eq(reworkCaptures.repo, "web-app"))
            .get();
        expect(marker?.failedCandidates).toBe(0);

        // A complete marker means the next run skips capture entirely.
        let captureCallsAfterCompletion = 0;
        await ensureRework(db, RUN, CONFIG, {
            captureLineDeaths: async () => {
                captureCallsAfterCompletion += 1;
                return { records: [], failedCandidates: 0 };
            },
        });
        expect(captureCallsAfterCompletion).toBe(0);
    } finally {
        handle.sqlite.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
