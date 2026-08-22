# spanical

## 0.2.0

### Minor Changes

- 9407b2d: Adds `spanical update`: checks GitHub Releases for a newer version, verifies the download against the release's SHA256SUMS, probe-runs it, and atomically replaces the running binary.

## 0.1.0

### Minor Changes

- 34a8282: Add `--format html` to the report command. It writes a single self-contained dashboard file (no external requests) with charts for net growth, added/deleted churn per period, contributor throughput share, monthly size and complexity trend, language mix, and hotspot scores.
