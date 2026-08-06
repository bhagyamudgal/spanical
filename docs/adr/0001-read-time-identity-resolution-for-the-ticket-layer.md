# Read-time identity resolution for the ticket layer

The code layer stores a resolved `author_id` on every commit, because re-extracting a local `git log` to correct attribution costs nothing. The ticket layer cannot make that trade: correcting attribution there would mean re-fetching over a rate-limited API. So `tickets` and `reviews` store the raw GitHub login and resolve it to a Canonical author through a join at query time, which means adding or re-pointing a login in `authors` fixes every previously synced row instantly and offline. Dropping a login is the exception: the binding it left behind is only reconciled by the next sync.

## Consequences

Every ticket-layer rollup carries a `LEFT JOIN` onto the login alias table, and logins that resolve to nobody have to be handled in SQL rather than rejected at write time. In exchange, the "run, read the unmapped-identity warnings, add the mapping, re-run" loop never costs an API call.

The two layers therefore resolve identity at different times on purpose. Sync does pre-seed an `authors` row and a login binding for a login the config does not declare, so that an unmapped contributor is still counted as somebody; what it must never do is store a resolved `author_id` on a ticket or a review, because that is the write a later config edit could not undo. Do not "fix" the inconsistency by resolving logins into ticket rows during sync.
