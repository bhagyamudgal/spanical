# spanical

[![CI](https://github.com/bhagyamudgal/spanical/actions/workflows/ci.yml/badge.svg)](https://github.com/bhagyamudgal/spanical/actions/workflows/ci.yml)

Local-first code-insights CLI that reads git history to tell the story of your engineering.

spanical answers four questions about a stretch of engineering: how much was built, when, by whom, and where the codebase is getting risky. You get period reports, throughput churn per period or per developer, hotspots (change frequency combined with complexity), surviving-line ownership with bus-factor warnings, an auto-narrated timeline, and an optional GitHub ticket layer covering pull request and issue flow, cycle time, thrash, and review load. Everything is computed locally from git history into a SQLite cache under `.spanical/`, with complexity measured by scc snapshots. Nothing leaves the machine except the ticket layer's reads from the GitHub GraphQL API.

## Requirements

- git on PATH; any command backed by scc snapshots (size, hotspots, contributors, ownership, report) needs full clone history, not a shallow clone.
- Nothing else for the released binary. Bun is only required to run from source.
- scc v3.7.0 is auto-installed on first run into `~/.spanical/bin` (pinned version, sha256 verified). An scc already on your PATH takes precedence.
- GITHUB_TOKEN is needed only for `tickets`, `reviews`, and the report's ticket section.

## Install

macOS or Linux, x64 or arm64:

```sh
curl -fsSL https://raw.githubusercontent.com/bhagyamudgal/spanical/main/install.sh | bash
```

The script downloads the binary for your platform, verifies its checksum against the published SHA256SUMS, and installs it as `~/.local/bin/spanical` (override the directory with `SPANICAL_INSTALL_DIR`). It warns if that directory is not on your PATH.

Alternatively, grab a `spanical-<os>-<arch>` asset from [GitHub Releases](https://github.com/bhagyamudgal/spanical/releases) and verify it against the SHA256SUMS published alongside it.

To run from source:

```sh
git clone https://github.com/bhagyamudgal/spanical.git
cd spanical
bun install
bun run build
cd packages/cli && bun link
```

## Quickstart

There is no init step. From inside any git repository:

```sh
spanical report
```

The first run extracts history into `.spanical/cache.db`, then prints a headline summary and writes a Markdown artifact such as `spanical-report-2025-08_2026-08.md`. An identical second run skips extraction silently (cache hit). From there:

```sh
spanical hotspots                  # refactor shortlist
spanical churn --last 6m --by dev  # effort per dev per period
spanical contributors              # whole-window per-dev activity, incl. rework
spanical tickets                   # PR and issue flow (needs tickets config + GITHUB_TOKEN)
```

`spanical hotspots` ranks files by change frequency and complexity:

```
$ spanical hotspots
┌───────────────────────────────┬─────────────┬────────────┬───────┬─────────┐
│ Path                          │ Change freq │ Complexity │ Score │ #Owners │
├───────────────────────────────┼─────────────┼────────────┼───────┼─────────┤
│ repo-alpha/src/core/engine.ts │           3 │          0 │ 0.000 │       3 │
└───────────────────────────────┴─────────────┴────────────┴───────┴─────────┘
```

## Commands

Every command shares one set of global flags, and `spanical <command> --help` lists them all.

| Command        | What it shows                                                                                     | Docs                                                  |
| -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `report`       | Headline summary plus a full Markdown artifact, or an offline HTML dashboard with `--format html` | [report](./apps/docs/commands/report.mdx)             |
| `churn`        | Commit volume and throughput churn per period, or per dev with `--by dev`                         | [churn](./apps/docs/commands/churn.mdx)               |
| `contributors` | Per-dev activity across the whole window, including rework lines                                  | [contributors](./apps/docs/commands/contributors.mdx) |
| `size`         | Monthly code size and complexity trend from scc snapshots                                         | [size](./apps/docs/commands/size.mdx)                 |
| `ownership`    | Surviving-line ownership per file and the bus-factor map, from git blame at HEAD                  | [ownership](./apps/docs/commands/ownership.mdx)       |
| `hotspots`     | Files ranked by change frequency times complexity                                                 | [hotspots](./apps/docs/commands/hotspots.mdx)         |
| `tickets`      | Per-dev pull request and issue flow, cycle time, thrash (GitHub)                                  | [tickets](./apps/docs/commands/tickets.mdx)           |
| `reviews`      | Review load, review latency, and team review coverage (GitHub)                                    | [reviews](./apps/docs/commands/reviews.mdx)           |
| `timeline`     | Period-by-period narrative with auto-detected events                                              | [timeline](./apps/docs/commands/timeline.mdx)         |
| `cache`        | Inspect and manage the local cache (`stats`, `rebuild`, `clear`)                                  | [cache](./apps/docs/commands/cache.mdx)               |
| `update`       | Self-update a release install to the latest GitHub release                                        | [update](./apps/docs/commands/update.mdx)             |

## Configuration

An optional `spanical.config.ts` is validated with zod at load and discovered by walking up from your current directory; the directory holding it also holds `.spanical/cache.db`.

```ts
import { defineConfig } from "spanical";

export default defineConfig({
    repos: [{ name: "alpha", path: "~/code/alpha" }],
    timezone: "America/New_York",
    exclude: ["**/*.lock", "**/dist/**"],
    authors: {
        "dev-one": { emails: ["dev1@example.com"], github: ["dev-one-gh"] },
    },
});
```

The `authors` block is the identity bridge: it resolves git emails and GitHub logins to one canonical author so both layers credit the same person once instead of twice. Full option reference in the [config docs](./apps/docs/configuration/config-file.mdx).

## Time windows

Exactly one selector per run: `--last 30d|6m|1y`, `--this week|month|quarter|year`, `--ytd`, or `--since 2026-01-01 --until 2026-06-30`. With no selector you get the last 12 months. All boundaries are computed in the active timezone (`--tz`, default UTC, weeks start Monday), and period granularity picks itself: weekly up to 8 weeks, monthly up to 18 months, quarterly beyond that. Details in the [time window docs](./apps/docs/configuration/time-windows.mdx).

## Development

Turborepo monorepo: `packages/cli` holds the CLI, with shared configs in `packages/typescript-config` and `packages/eslint-config`.

```sh
bun install        # workspace dependencies
bun dev:cli        # run the CLI from source
bun test           # unit and integration tests
bun run typecheck  # tsc across the workspace
bun run lint
bun run format
```

Releases flow through changesets: user-facing pull requests carry a changeset entry, which accumulates into the version-packages release that builds the platform binaries and updates install.sh's release assets.

## Documentation

Command-by-command docs (Mintlify source) live in `apps/docs`. To browse them locally:

```sh
cd apps/docs && bun run dev
```
