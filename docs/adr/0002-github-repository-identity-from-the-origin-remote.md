# GitHub repository identity comes from the origin remote

spanical is meant to run inside a git repository, with `spanical.config.ts` as an optional convenience rather than a requirement. A configured list of GitHub repositories therefore cannot be the source of truth for which repository to sync, because it only exists when a config file does. The `owner/name` slug is parsed from the repository's `origin` remote instead, with an optional per-repo `github` field in config as an override.

## Considered options

An explicit `tickets.github.repos` list was the original design and is what the build spec sketches. It was dropped because it makes the ticket layer unusable without a config file, and because a declared list drifts from reality when a repository is renamed or forked. Matching a local directory name against the GitHub repository name was rejected as implicit magic that breaks whenever a clone is named differently from its remote.

## Consequences

Repository scoping now behaves identically across both layers, so `--repo` filters code and tickets the same way. A repository with no `origin`, or an `origin` that is not GitHub, must fail with a clear message rather than a parse error. The override field exists for forks, non-`origin` remote names, and repositories renamed upstream.
