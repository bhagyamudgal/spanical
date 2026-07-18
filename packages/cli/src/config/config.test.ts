import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, parseConfig } from "./load";

test("parseConfig fills all documented defaults from a minimal config", () => {
    const cfg = parseConfig({
        repos: [{ name: "web-app", path: "../web-app" }],
    });
    expect(cfg.timezone).toBe("Europe/Zurich");
    expect(cfg.exclude).toEqual([
        "**/*.lock",
        "**/dist/**",
        "**/.next/**",
        "**/*.snap",
    ]);
    expect(cfg.migrationsPath).toBe("**/migrations/**");
    expect(cfg.authors).toEqual({});
    expect(cfg.hotspot).toEqual({
        minFileLines: 50,
        busFactorThreshold: 0.8,
    });
    expect(cfg.reworkWindowDays).toBe(21);
    expect(cfg.since).toBeUndefined();
    expect(cfg.tickets).toBeUndefined();
});

test("parseConfig round-trips a per-repo branch override", () => {
    const cfg = parseConfig({
        repos: [{ name: "shared", path: "../shared", branch: "develop" }],
    });
    expect(cfg.repos[0]?.branch).toBe("develop");
});

test("parseConfig throws a readable ConfigError naming the offending path", () => {
    try {
        parseConfig({ repos: [{ name: "web-app" }] });
        throw new Error("expected parseConfig to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        if (error instanceof ConfigError) {
            expect(error.message).toContain("repos.0.path");
        }
    }
});

test("parseConfig rejects an empty repos array", () => {
    expect(() => parseConfig({ repos: [] })).toThrow(ConfigError);
});

test("parseConfig accepts a valid tickets block with an env token reference", () => {
    const cfg = parseConfig({
        repos: [{ name: "web-app", path: "../web-app" }],
        tickets: {
            source: "github",
            github: {
                repos: ["owner/web-app"],
                token: "env:GITHUB_TOKEN",
            },
        },
    });
    expect(cfg.tickets?.github.token).toBe("env:GITHUB_TOKEN");
    expect(cfg.tickets?.github.includeIssues).toBe(true);
    expect(cfg.tickets?.attribution).toBe("assignee");
});

test("parseConfig rejects a literal (non-env) token", () => {
    expect(() =>
        parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            tickets: {
                source: "github",
                github: {
                    repos: ["owner/web-app"],
                    token: "ghp_literal",
                },
            },
        })
    ).toThrow(ConfigError);
});

function writeFixture(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-cfg-"));
    writeFileSync(join(dir, "spanical.config.ts"), contents);
    return dir;
}

const MINIMAL_FIXTURE = `export default { repos: [{ name: "web-app", path: "../web-app" }] };`;

test("loadConfig loads spanical.config.ts from cwd", async () => {
    const dir = writeFixture(MINIMAL_FIXTURE);
    try {
        const cfg = await loadConfig({ cwd: dir });
        expect(cfg.repos[0]?.name).toBe("web-app");
        expect(cfg.timezone).toBe("Europe/Zurich");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadConfig honors an explicit configPath", async () => {
    const dir = writeFixture(MINIMAL_FIXTURE);
    try {
        const cfg = await loadConfig({
            configPath: join(dir, "spanical.config.ts"),
        });
        expect(cfg.repos[0]?.path).toBe("../web-app");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadConfig throws a clear ConfigError when the file is missing", async () => {
    await expect(
        loadConfig({ cwd: mkdtempSync(join(tmpdir(), "spanical-empty-")) })
    ).rejects.toThrow(/No spanical config/);
});
