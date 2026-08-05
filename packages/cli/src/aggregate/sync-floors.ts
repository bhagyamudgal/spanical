import { inArray } from "drizzle-orm";
import type { CacheDatabase } from "../cache/open";
import { githubSyncs } from "../cache/schema";
import { zonedStartOfDay } from "../window";
import type { SyncFloor } from "./types";

// A sync floor later than the window start means the cache cannot hold the span
// the window asks for, and widening the window does not re-sync. Reported as
// data rather than prose so a run can be tested for the coverage it has.
export function readLateSyncFloors(
    db: CacheDatabase,
    opts: { repos: string[]; timezone: string; windowStart: Date | null }
): SyncFloor[] {
    // An unbounded window asks for all history, so every sync floor is later
    // than its start — that is the window a truncated cache misleads most.
    const startedAt = opts.windowStart?.getTime() ?? Number.NEGATIVE_INFINITY;
    return db
        .select({ repo: githubSyncs.repo, since: githubSyncs.since })
        .from(githubSyncs)
        .where(inArray(githubSyncs.repo, opts.repos))
        .orderBy(githubSyncs.repo)
        .all()
        .flatMap(({ repo, since }) =>
            since !== null &&
            zonedStartOfDay(since, opts.timezone).getTime() > startedAt
                ? [{ repo, since }]
                : []
        );
}
