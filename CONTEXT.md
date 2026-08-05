# spanical

A local-first code-insights CLI that reads git history and tells the story of a stretch of engineering — how much was built, when, by whom, and where the codebase is getting risky. This glossary fixes the vocabulary so the report, the code, and the issues all mean the same thing by the same word.

## Language

### Code layer

**Hotspot**:
A file that scores high on both change frequency and complexity at once — the refactor shortlist. Neither axis alone qualifies a file; the _product_ of the two is the signal.
_Avoid_: risky file, problem file

**Change frequency**:
The count of distinct no-merge commits that touched a file within the analysis window — the "how often did we have to open this file" axis of a Hotspot. A single bulk commit counts once, so reformats and dir-restructures don't fake a hotspot.
_Avoid_: churn frequency, revision count

**Throughput churn**:
Added + deleted lines over a span (`added + deleted`). The volume-of-edits measure. Deliberately _not_ the change-frequency axis of a Hotspot — it is dominated by one-off bulk edits.
_Avoid_: churn (unqualified), LOC touched

**Complexity**:
Cyclomatic complexity as reported by `scc` for a file at a monthly snapshot. Always a snapshot value, never a per-diff value — this is why per-dev complexity is approximate.

**Complexity attribution**:
The approximate assignment of a file's snapshot-to-snapshot Complexity change to the developers who touched it that period, split by churn share. Explicitly approximate — it reads snapshots, not diffs.

**Ownership**:
The share of a file's currently-surviving lines (on HEAD, via `git blame`) credited to each canonical author. A "now" property of the codebase, independent of the analysis window.
_Avoid_: authorship (that's who committed, a window concept)

**Primary owner**:
The author holding more than 50% of a file's surviving lines. A file may have none (genuinely shared) or exactly one.

**Sole owner**:
The single author holding at least the bus-factor threshold (default 0.8) of a file's surviving lines — a risk to the team, never a badge.
_Avoid_: main author, code owner

**Bus factor**:
The risk that knowledge of a file or area lives in too few heads; concretely surfaced as the count of Sole-owner files.

**Bus-factor map**:
Sole-owner files aggregated by immediate-parent directory (repo-qualified) — the "which areas ride on one person" view.

**Timeline event**:
An auto-detected notable occurrence within a period — a Dominant commit, a churn-spike period, a removal period, or the busiest-period anchor — surfaced in the month-by-month narrative.

**Dominant commit**:
A single commit contributing at least 40% of its period's Throughput churn — the flag for restructures, big landings, and mass removals that distort a period even after `-M -C` rename detection.

### Ticket layer

**Ticket**:
A pull request or an issue. Pull requests are the delivery unit — a merge is throughput; issues are the planning unit — their open and close counts read as scope signal, never as delivery.

**Thrash**:
Rework visible at the ticket level: reopened tickets and reverted pull requests. Distinct from Throughput churn, which counts lines rather than reversals.
_Avoid_: churn (unqualified), rework churn (that's the line-lifetime metric)

**Revert match**:
The rule pairing a pull request titled `Revert "X"` with the most recently merged cached pull request titled X in the same repo that had already merged when the revert was opened, so the Thrash counts against the reverted work rather than the person who reverted it. Only merged work is a candidate — nothing else ever landed to be undone. Explicitly approximate — GitHub exposes no revert relationship, so an unmatched title counts only at team level.

**Cycle time**:
Elapsed time from a pull request opening to its merge, reported as a median.

### Identity

**Canonical author**:
The single identity a human resolves to across both layers, holding their git emails and GitHub logins. Every per-dev number is counted against this, never against a raw email or login.

**Identity bridge**:
The resolution of a git email and a GitHub login to one Canonical author. Without it the code layer and the ticket layer credit the same person twice.

**Provisional author**:
A Canonical author the tool minted itself from an unrecognized git email or GitHub login rather than from a configured `authors` entry. Always surfaced as a warning — it may be a duplicate of someone already known.

**Auto-bridged identity**:
A git-to-GitHub link inferred from a `users.noreply.github.com` address, which embeds the GitHub login. A configured `authors` entry always overrides it.
