import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
    ConfigError,
    loadConfig,
    parseConfig,
    resolveConfig,
    resolveConfigPath,
} from "./load";
import { defineConfig } from "../public";

test("parseConfig fills all documented defaults from a minimal config", () => {
    const cfg = parseConfig({
        repos: [{ name: "web-app", path: "../web-app" }],
    });
    expect(cfg.timezone).toBe("UTC");
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

test("parseConfig rejects a token that is not env:GITHUB_TOKEN", () => {
    expect(() =>
        parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            tickets: {
                source: "github",
                github: {
                    repos: ["owner/web-app"],
                    token: "env:OTHER_TOKEN",
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

const MINIMAL_FIXTURE = `import { defineConfig } from "${import.meta.dir}/../public";
export default defineConfig({ repos: [{ name: "web-app", path: "../web-app" }] });`;

test("loadConfig loads spanical.config.ts from cwd", async () => {
    const dir = writeFixture(MINIMAL_FIXTURE);
    try {
        const cfg = await loadConfig({ cwd: dir });
        expect(cfg.repos[0]?.name).toBe("web-app");
        expect(cfg.timezone).toBe("UTC");
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

test("defineConfig returns its input unchanged (identity)", () => {
    const input = { repos: [{ name: "web-app", path: "../web-app" }] };
    expect(defineConfig(input)).toBe(input);
});

test("parseConfig rejects an unknown key instead of silently dropping it", () => {
    try {
        parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            timezon: "UTC",
        });
        throw new Error("expected parseConfig to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        if (error instanceof ConfigError) {
            expect(error.message).toContain("timezon");
        }
    }
});

test("parseConfig rejects a non-existent calendar date for since", () => {
    expect(() =>
        parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            since: "2025-13-45",
        })
    ).toThrow(ConfigError);
});

test("parseConfig accepts a valid since date", () => {
    const cfg = parseConfig({
        repos: [{ name: "web-app", path: "../web-app" }],
        since: "2025-07-01",
    });
    expect(cfg.since).toBe("2025-07-01");
});

test("parseConfig rejects an invalid IANA timezone", () => {
    expect(() =>
        parseConfig({
            repos: [{ name: "web-app", path: "../web-app" }],
            timezone: "Europe/Zurick",
        })
    ).toThrow(ConfigError);
});

test("parseConfig rejects duplicate repo names", () => {
    expect(() =>
        parseConfig({
            repos: [
                { name: "web-app", path: "../a" },
                { name: "web-app", path: "../b" },
            ],
        })
    ).toThrow(ConfigError);
});

test("loadConfig fails clearly when the config has no default export", async () => {
    const dir = writeFixture(
        `export const config = { repos: [{ name: "web-app", path: "../web-app" }] };`
    );
    try {
        await expect(loadConfig({ cwd: dir })).rejects.toThrow(
            /no default export/
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function initGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "spanical-cfg-repo-"));
    const result = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    if (result.exitCode !== 0) {
        throw new Error(`git init failed: ${result.stderr.toString()}`);
    }
    return dir;
}

test("resolveConfig falls back to the working directory's git repo when no config file exists", async () => {
    const dir = initGitRepo();
    try {
        const cfg = await resolveConfig({ cwd: dir });
        expect(cfg.repos).toHaveLength(1);
        expect(cfg.repos[0]?.name).toBe(basename(dir));
        expect(cfg.timezone).toBe("UTC");
        expect(cfg.authors).toEqual({});
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a config at the repo root is discovered from a subdirectory", async () => {
    const dir = initGitRepo();
    try {
        writeFileSync(join(dir, "spanical.config.ts"), MINIMAL_FIXTURE);
        const nested = join(dir, "packages", "web");
        mkdirSync(nested, { recursive: true });

        expect(resolveConfigPath({ cwd: nested })).toBe(
            join(dir, "spanical.config.ts")
        );
        const cfg = await resolveConfig({ cwd: nested });
        expect(cfg.repos[0]?.name).toBe("web-app");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("discovery stops at the git root instead of escaping the repository", async () => {
    const outer = mkdtempSync(join(tmpdir(), "spanical-outer-"));
    try {
        writeFileSync(join(outer, "spanical.config.ts"), MINIMAL_FIXTURE);
        const inner = join(outer, "inner");
        mkdirSync(inner, { recursive: true });
        const init = Bun.spawnSync(["git", "init", "-q"], { cwd: inner });
        if (init.exitCode !== 0) {
            throw new Error(`git init failed: ${init.stderr.toString()}`);
        }

        expect(resolveConfigPath({ cwd: inner })).toBe(
            join(inner, "spanical.config.ts")
        );
        const cfg = await resolveConfig({ cwd: inner });
        expect(cfg.repos[0]?.name).toBe(basename(inner));
    } finally {
        rmSync(outer, { recursive: true, force: true });
    }
});

test("a subdirectory run keeps the config path at the git root when none exists", () => {
    const dir = initGitRepo();
    try {
        const nested = join(dir, "packages", "web");
        mkdirSync(nested, { recursive: true });
        expect(resolveConfigPath({ cwd: nested })).toBe(
            join(dir, "spanical.config.ts")
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a dangling config symlink errors instead of falling back to defaults", async () => {
    const dir = initGitRepo();
    try {
        symlinkSync(join(dir, "missing.ts"), join(dir, "spanical.config.ts"));
        await expect(resolveConfig({ cwd: dir })).rejects.toThrow(
            /No spanical config/
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an empty --config value is treated as no explicit path", async () => {
    const dir = initGitRepo();
    try {
        writeFileSync(join(dir, "spanical.config.ts"), MINIMAL_FIXTURE);
        const cfg = await resolveConfig({ configPath: "", cwd: dir });
        expect(cfg.repos[0]?.name).toBe("web-app");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveConfig prefers explicit repos over the working directory's git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spanical-not-a-repo-"));
    try {
        const cfg = await resolveConfig({
            cwd: dir,
            repos: [{ name: "web-app", path: "../web-app" }],
        });
        expect(cfg.repos).toEqual([{ name: "web-app", path: "../web-app" }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveConfig errors when there is neither a config file nor a git repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spanical-not-a-repo-"));
    try {
        await expect(resolveConfig({ cwd: dir })).rejects.toThrow(
            /not inside a git repository/
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveConfig still errors when an explicit config path does not exist", async () => {
    const dir = initGitRepo();
    try {
        await expect(
            resolveConfig({
                configPath: join(dir, "does-not-exist.ts"),
                cwd: dir,
            })
        ).rejects.toThrow(/No spanical config/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadConfig surfaces an import-time error as IMPORT_FAILED with its cause", async () => {
    const dir = writeFixture(`throw new Error("boom at eval");`);
    try {
        await loadConfig({ cwd: dir });
        throw new Error("expected loadConfig to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        if (error instanceof ConfigError) {
            expect(error.code).toBe("CONFIG_IMPORT_FAILED");
            expect(error.cause).toBeInstanceOf(Error);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
