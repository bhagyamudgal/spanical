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
    type ExtractionResult,
    type RepoExtraction,
} from "./ingest";
