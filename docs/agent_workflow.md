# Agent Workflow

How work moves through this repo using the configured agent skills. Per-repo configuration lives in `docs/agents/` (issue tracker conventions, triage labels, domain-doc rules).

## The pipeline

1. **Design** — `/grilling` or `/grill-me` to stress-test decisions one question at a time. For architectural sessions use `/grill-with-docs`: decisions get recorded as ADRs in `docs/adr/` and glossary updates in `CONTEXT.md` (via `/domain-modeling`) instead of evaporating with the conversation.
2. **Spec** — `/to-spec` turns the settled conversation into a spec, published as a GitHub issue.
3. **Tickets** — `/to-tickets` breaks the spec into tracer-bullet tickets, each declaring its blocking edges as native GitHub issue dependencies.
4. **Triage** — `/triage` moves issues through the label state machine: `needs-triage` → `needs-info` | `ready-for-agent` | `ready-for-human` | `wontfix`. A `ready-for-agent` ticket carries a fully-specified agent-ready brief.
5. **Plan gate** — `/harden-plan` grounds the ticket's plan against the real codebase before any code is written.
6. **Execute** — `/implement` for a single well-specified ticket; `/executing-tickets-with-subagents` for bundled multi-task tickets (one subagent per task, two-stage spec + quality review, manual-QA handoff doc).
7. **Verify** — `/done` after every task: type-check, parallel review, simplify, comment scan, commit-message suggestions (never auto-commits).
8. **Review** — `/review-pr` on the PR, `/fix-pr-review` to triage and apply findings.
9. **Big work** — `/wayfinder` maps multi-session epics as decision tickets on the tracker; `/handoff` compacts a session for the next one to pick up.

## Unattended queue

Overnight/unattended runs work through open `ready-for-agent` tickets — one subagent per ticket, decisions documented for morning review, anything irreversible queued with ready-to-run instructions instead of executed.

## Domain language

Use `CONTEXT.md`'s terms in issues, code, and reports — don't drift to the synonyms the glossary avoids. Decisions that constrain future work become ADRs in `docs/adr/`. Output that contradicts an existing ADR must flag the conflict explicitly, never silently override it.
