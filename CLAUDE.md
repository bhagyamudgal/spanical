# CLAUDE.md — spanical

spanical is a local-first code-insights CLI: it reads git history and tells the story of any stretch of engineering — how much was built, when, by whom, and where the codebase is getting risky (churn × complexity hotspots, ownership/bus-factor, ticket/PR/review flow). TypeScript on Bun.

## Project rules (read first)

- **The build spec is local-only.** `docs/private/` is gitignored on purpose; `docs/private/spec.md` is the source of truth for what to build and must never be committed or pushed. GitHub issues cite its sections ("spec §N") — if you don't have the spec, ask the repo owner. Docs that are safe to publish go directly in `docs/`.
- **This is a public repo — no private references.** Never mention the author's employer, client or company names, internal repo names, coworker names or emails, or other personal details in issues, PRs, commits, code, comments, tests, or fixtures. Use generic placeholders in examples (`user@example.com`, "a work repo").
- **Everything public reads human-authored.** No AI/agent references, no "Generated with" footers, no session links in commits, PR titles/bodies, or issues.
- **Work flows issue-by-issue** in milestone order (Phase 1 → 4, strictly sequential). Issues are PR-sized — one issue, one PR. Phase 2–4 issues are intentionally lean; add implementation detail when the phase starts, informed by the phases before it.

## Stack (resolved decisions — build to these)

- **Runtime:** Bun (workspaces, `bun test`, `bun:sqlite`). Not Node, not pnpm.
- **Repo shape:** Turborepo monorepo — `packages/cli` (package name `spanical`), `packages/typescript-config`, `packages/eslint-config`; `apps/` reserved (`apps/landing` for spanical.com comes in Phase 4).
- **CLI framework:** `@drizzle-team/brocli` with one shared global-flags options object spread into every subcommand.
- **Storage:** SQLite cache (`.spanical/cache.db`) via Drizzle ORM on `bun:sqlite`; drop to raw SQL with the `sql` operator for heavy rollups.
- **Rendering:** `cli-table3` + `picocolors` for terminal; Markdown and JSON formatters hand-rolled.
- **Dates/TZ:** `date-fns` v4 + `@date-fns/tz` — all period boundaries computed as TZDate in the configured zone.
- **Config:** `spanical.config.ts` with `defineConfig()` + zod validation at load.
- **External binaries:** `git` required on PATH; `scc` auto-downloads on first run (PATH-installed scc takes precedence; pinned version, checksum-verified, into `~/.spanical/bin`).
- **Testing:** `bun test` — unit tests for pure logic; integration tests build throwaway fixture git repos in temp dirs and run real extraction.
- **Distribution:** `bun link` for dev; public rollout via tag-triggered GitHub Actions matrix (`bun build --compile` per platform) → GitHub Release + `install.sh`.
- **Reference implementations:** [dbmux](https://github.com/bhagyamudgal/dbmux) for the monorepo shape and turbo.json; [worktree-cli](https://github.com/bhagyamudgal/worktree-cli) for the brocli CLI structure and release pipeline. Check them before inventing structure.

---

# Working rules

These mirror the owner's global standards. Follow them exactly.

## Workflow

- Use subagents to do tasks or implement plans so the main context stays free to oversee the work.
- Don't assume anything. If anything is ambiguous or you're not confident, stop and ask before acting — but investigate first and present concrete, considered options with a recommendation, not open-ended questions.

## Behavioral Guidelines

### 1. Think Before Coding

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Sanity check: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused.

Test: every changed line should trace directly to the task.

### 4. Goal-Driven Execution

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with verification per step.

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Minimal code impact.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes touch only what's necessary.

## Pre-Flight Reading

Before writing code, read:

1. **The target file** in full — not just the snippet you're changing
2. **2-3 sibling files** in the same directory — to absorb the local pattern
3. **One reference implementation** of a similar feature — find the closest analog and mimic its structure
4. **Imports and types used** — verify they exist and have the shape you assume

## Investigation Discipline

- **Find the root cause before patching** — a fix you don't understand is not a fix
- **Adding a null check is a smell** — ask: "why is this ever null? should it be?"
- **Adding try-catch around a mystery error is a smell** — catch only what you understand and can handle
- **`as any` / `as unknown` / `@ts-ignore` are smells** — fix the type, don't hide it
- **If a test is failing, understand why before changing the test** — the test is often right
- **Reading the error message is step zero**

Bandaid budget: zero per PR.

## Stop-Loss Triggers

STOP and re-plan (don't keep trying variations) when:

- The same approach has failed 2 times with similar errors
- You're modifying the same file 3+ times in a row trying to get it right
- The fix is getting bigger than the original change requested
- You're rationalizing why a test failure "doesn't really matter"

## Honest Completion Reporting

- **Verified vs assumed**: state explicitly what you ran and what you only inspected.
- **Known gaps**: if you skipped edge cases, list them.
- **Partial work**: say "I did X and Y; Z is not done because [reason]" — never "done!" with hidden gaps.

## TypeScript Rules

- Always use `type` instead of `interface`
- Always use `function` keyword to define functions, not arrow functions (arrows OK for inline callbacks)
- No non-null assertions (`!.`) — refactor to proper type-safe patterns
- No `any` type — use `unknown` and narrow if types can't be defined
- No type assertions (`as`) unless absolutely unavoidable; if unavoidable, comment why
- Strict mode always enabled
- Verify via CLI type-check (`bun run typecheck`) after every change and loop until clean

## Error Handling

Use the `tryCatch` utility from `lib/try-catch.ts` instead of try-catch blocks:

```typescript
const { data: user, error } = await tryCatch(getUser(id));
const { data: config, error } = tryCatchSync(() => JSON.parse(jsonString));
```

## Comments

Do not write comments unless the logic is genuinely complex. Comments explain WHY, never WHAT. No JSDoc for obvious functions. No section dividers.

## File Size

Keep files under ~400 LOC as a guideline. Split when a file has multiple concerns, not at an arbitrary number.

## Code Quality

- Follow DRY — extract repeated logic into reusable functions
- Keep functions small — one function = one job
- No emoji in logs or code
- Prefer early returns over nested conditionals
- No magic numbers or strings — use named constants
- Meaningful variable names; booleans use `is`/`has`/`can`/`should` prefixes, positive framing (`isEnabled`, not `disabled`)
- `const` over `let`; `async/await` over `.then()`; no nested ternaries
- Named exports over default exports
- Template literals over string concatenation
- No `console.log` in production code — use the project logger
- No abbreviations except universal ones (`URL`, `ID`, `API`)
- Functions are verbs, variables are nouns, types are nouns/adjectives
- No generic suffixes (`Manager`, `Handler`, `Helper`) — use the verb

## DRY & Reuse Discipline

Before writing any new utility, type, schema, or helper — **search the codebase first**:

1. **Name layer**: grep for the exact + camelCase + snake_case name
2. **Behavior layer**: grep for what it does (`format.*date`, `parse.*`)
3. **Reference layer**: find a feature that uses the thing, follow its imports

Reuse hierarchy: use as-is → compose → extend → generalize → (last resort) write new. Prefer `z.infer<typeof schema>` over hand-written duplicate types. Three similar lines are fine; abstract on the fourth occurrence, not the second.

## Performance Checklist

- **Parallel async**: independent async calls go in `Promise.all` — never sequential awaits for unrelated data
- **N+1 queries**: never query inside a sequential loop — batch or join instead
- **Select only needed columns** for list-shaped queries
- **Avoid redundant queries**: reuse data already fetched
- **Concurrency**: if 2+ writers touch the same row, use a transaction; if a check + write must be atomic, enforce it in the database, not application logic

## Logging Discipline

- Log levels: `error` = needs attention, `warn` = recoverable anomaly, `info` = state transition, `debug` = development noise
- Structured logging: key-value pairs, not formatted strings
- Never log secrets, tokens, or raw PII
- Don't log inside hot paths (a line per row in a 10k-row loop)

## Security Mindset

- **Validate at boundaries**: all external input validated via zod before reaching business logic
- **Parameterized queries only**: never string-interpolate input into SQL
- **Secrets in env vars**: never commit, never hardcode, never echo in error messages

## Test Discipline

- **Bug fix flow**: write the failing test that reproduces the bug first, then fix it
- **Don't delete failing tests to make CI green** — understand why they fail first
- **Don't change tests to match buggy behavior**
- **Test behavior, not implementation**
- One assertion focus per test

## Conventions

- **Null vs undefined**: `null` for intentional absence ("not found" is expected), `undefined` for optional/not set
- **`import type`** for type-only imports
- **Error shape**: `type AppError = { code: string; message: string; cause?: unknown }` with domain error-code constants
- **Zod**: derive types from schemas (`z.infer`); reuse with `.extend()`/`.partial()`
- **Dates**: store UTC, ISO strings in transport, convert to local only in UI; use date-fns, never raw Date math

## Git

- Conventional commits: `feat:` / `fix:` / `refactor:` / `chore:` / `docs:` — simple `-m` flag, no heredoc
- One logical change per commit; messages explain WHY, not WHAT
- No drive-by refactors; small PRs (under ~400 lines diff ideal)
- Review your own diff before pushing — justify every changed line
- No commits with debug noise (leftover logs, commented-out code)
- Never commit without explicit permission from the repo owner
- Branch naming: `bhagya/fix-<issue>`, `bhagya/feat-<feature>`, `feature/<name>` for shared work

## React / Next.js (applies when apps/landing lands)

- Avoid `useEffect` for state derivation — compute during render or `useMemo`
- Use `key` prop to reset component state, not `useEffect`
- `useMemo` only for expensive computations; `useCallback` only when passing to memoized children
- Next.js 16: `middleware.ts` is renamed `proxy.ts`
