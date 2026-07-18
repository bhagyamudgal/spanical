import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TZDate } from "@date-fns/tz";
import { resolveRunConfig } from "./resolve-run";
import { WindowError } from "../window";

const NOW = new TZDate("2026-07-18T12:00:00Z", "UTC");

const FIXTURE = `import { defineConfig } from "${import.meta.dir}/../public";
export default defineConfig({
    repos: [{ name: "web-app", path: "../web-app" }],
    exclude: ["**/*.lock"],
});`;

function writeFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-run-"));
    writeFileSync(join(dir, "spanical.config.ts"), FIXTURE);
    return dir;
}

test("a --tz flag beats the config timezone", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({
            flags: { tz: "Asia/Kolkata" },
            cwd: dir,
            now: NOW,
        });
        expect(run.tz).toBe("Asia/Kolkata");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("without a --tz flag the config timezone is used", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({ flags: {}, cwd: dir, now: NOW });
        expect(run.tz).toBe("UTC");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--repo replaces config repos and derives names from basenames", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({
            flags: { repo: "../web-app,../api" },
            cwd: dir,
            now: NOW,
        });
        expect(run.repos.map((repo) => repo.name)).toEqual(["web-app", "api"]);
        expect(run.repos[0]?.path).toBe("../web-app");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--repo rejects paths that collapse to duplicate basenames", async () => {
    const dir = writeFixture();
    try {
        await expect(
            resolveRunConfig({
                flags: { repo: "../frontend/web,../backend/web" },
                cwd: dir,
                now: NOW,
            })
        ).rejects.toThrow(WindowError);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--exclude replaces the config exclude list", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({
            flags: { exclude: "**/gen/**" },
            cwd: dir,
            now: NOW,
        });
        expect(run.exclude).toEqual(["**/gen/**"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("without --exclude the config exclude list is preserved", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({ flags: {}, cwd: dir, now: NOW });
        expect(run.exclude).toEqual(["**/*.lock"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("by, format, out, and cache fall back to their defaults", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({ flags: {}, cwd: dir, now: NOW });
        expect(run.by).toBe("dev");
        expect(run.format).toBe("table");
        expect(run.out).toBeNull();
        expect(run.cache).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("--no-cache disables the cache", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({
            flags: { "no-cache": true },
            cwd: dir,
            now: NOW,
        });
        expect(run.cache).toBe(false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an invalid timezone throws a WindowError", async () => {
    const dir = writeFixture();
    try {
        await expect(
            resolveRunConfig({
                flags: { tz: "Not/AZone" },
                cwd: dir,
                now: NOW,
            })
        ).rejects.toThrow(WindowError);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("the window is resolved from the window selector flags", async () => {
    const dir = writeFixture();
    try {
        const run = await resolveRunConfig({
            flags: { last: "30d" },
            cwd: dir,
            now: NOW,
        });
        expect(run.window.granularity).toBe("week");
        expect(run.window.label).toContain("last 30d");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
