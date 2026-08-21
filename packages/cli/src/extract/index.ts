export type { ParsedCoAuthor, ParsedCommit, ParsedFileChange } from "./types";
export {
    BODY_END,
    FIELD_SEPARATOR,
    GIT_LOG_FORMAT,
    RECORD_SEPARATOR,
    parseCoAuthorTrailers,
    parseCommitRecord,
    parseGitLog,
    parseNumstatLine,
} from "./parse";
export { EXTRACT_ERROR_CODES, ExtractError } from "./errors";
export {
    extractAll,
    extractRepo,
    extractWithConfig,
    type ExtractionResult,
    type RepoExtraction,
} from "./ingest";
export {
    bucketDeletionsByVictim,
    captureLineDeaths,
    parseDeletedRanges,
    type DeletedRange,
    type LineDeathCandidate,
    type LineDeathRecord,
    type VictimBucket,
} from "./rework";
