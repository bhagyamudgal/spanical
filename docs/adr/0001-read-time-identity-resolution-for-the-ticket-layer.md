# Read-time identity resolution for the ticket layer

The code layer stores a resolved `author_id` on every commit, because re-extracting a local `git log` to correct attribution costs nothing. The ticket layer cannot make that trade: correcting attribution there would mean re-fetching over a rate-limited API. So `tickets` and `reviews` store the raw GitHub login and resolve it to a Canonical author through a join at query time, which means editing `authors` in the config fixes every previously synced row instantly and offline.

## Consequences

Every ticket-layer rollup carries a `LEFT JOIN` onto the login alias table, and logins that resolve to nobody have to be handled in SQL rather than rejected at write time. In exchange, the "run, read the unmapped-identity warnings, add the mapping, re-run" loop never costs an API call.

The two layers therefore resolve identity at different times on purpose. Do not "fix" the inconsistency by resolving logins during sync.
