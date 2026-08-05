# The ticket layer syncs incrementally; the code layer keeps full-refreshing

Code extraction deletes every row for a repository and re-reads the whole history whenever its branch tip, `since` bound, or author mapping changes. That is the right shape for a local `git log`, which is free to re-read. It is the wrong shape for a rate-limited API, so the ticket layer instead keeps a per-repository cursor and fetches only what changed since the last sync.

## Consequences

The two layers cache differently on purpose, and the ticket layer carries a watermark the code layer does not need: the cursor records both the `since` bound the cache was built under and how far it has been synced. Recording only "last synced at" would let a cache built for one month silently answer a twelve-month question, so a `since` that moves earlier must re-run the backfill for that repository.

Window filtering stays in SQL for both layers. Neither one scopes its fetch to the requested reporting window, which is what lets a single cache answer any window without refetching.
