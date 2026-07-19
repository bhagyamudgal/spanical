export { CacheError, CACHE_ERROR_CODES } from "./errors";
export {
    CACHE_SCHEMA_VERSION,
    openCache,
    rebuildSchema,
    resolveCachePath,
    type CacheDatabase,
    type CacheHandle,
} from "./open";
export {
    authors,
    authorAliases,
    commits,
    fileChanges,
    sccSnapshots,
    extractions,
    cacheSchema,
    cacheTables,
    CACHE_TABLE_NAMES,
} from "./schema";
export {
    clearCache,
    formatCacheStats,
    gatherCacheStats,
    rebuildCache,
    type CacheStats,
    type LastExtraction,
    type TableCount,
} from "./stats";
export { CACHE_INDEX_NAMES } from "./ddl";
