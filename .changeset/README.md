# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to version the CLI and generate its changelog.

## Adding a changeset

Every user-facing change ships with a changeset. After making your change, run:

```bash
bunx changeset
```

Select `spanical`, choose a bump type (`patch` for fixes, `minor` for features), and write one or two sentences a reader of the changelog would care about. Commit the generated `.changeset/*.md` file with your pull request.

## Releasing

When pending changesets accumulate on main, the bot opens a "chore: version packages" pull request that bumps `packages/cli/package.json` and writes `packages/cli/CHANGELOG.md`. Merging that pull request builds every platform binary, attaches checksums, and publishes the GitHub release automatically. Nothing else to do.
