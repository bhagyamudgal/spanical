import { tryCatch, tryCatchSync } from "@spanical/utils";
import { ExtractError } from "../extract/errors";
import { runGit } from "../extract/git";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";

const GITHUB_HOST = "github.com";
const SCHEME_SEPARATOR = "://";
const SCP_LIKE_REMOTE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;
const URL_USERINFO = /:\/\/[^/@]*@/;
const REDACTED_USERINFO = "://***@";
const GIT_SUFFIX = ".git";
const SLUG_SEGMENT_COUNT = 2;
const NO_SUCH_REMOTE_EXIT_CODE = 2;
const ORIGIN_MISSING_CAUSE = `has no "origin" remote, so its GitHub repository cannot be determined. Add an origin remote, or set github: "owner/name" on that repo entry in spanical.config.ts.`;
const ORIGIN_NOT_GITHUB_CAUSE = `that is not a ${GITHUB_HOST} repository. Set github: "owner/name" on that repo entry in spanical.config.ts.`;

export type RepoSlug = { owner: string; name: string };

type RepoRef = { name: string; path: string; github?: string };

export function formatSlug(slug: RepoSlug): string {
    return `${slug.owner}/${slug.name}`;
}

// A malformed percent-escape has to read as an invalid slug rather than throw a
// bare URIError out of config validation, and decoding only after the split
// keeps an escaped separator from inventing a segment.
function decodeSegment(segment: string): string | null {
    return tryCatchSync(() => decodeURIComponent(segment)).data;
}

export function parseSlugPath(path: string): RepoSlug | null {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length !== SLUG_SEGMENT_COUNT) {
        return null;
    }
    const [rawOwner, rawName] = segments;
    if (rawOwner === undefined || rawName === undefined) {
        return null;
    }
    const owner = decodeSegment(rawOwner);
    const lastSegment = decodeSegment(rawName);
    if (owner === null || lastSegment === null) {
        return null;
    }
    const name = lastSegment.endsWith(GIT_SUFFIX)
        ? lastSegment.slice(0, -GIT_SUFFIX.length)
        : lastSegment;
    return name.length === 0 ? null : { owner, name };
}

// Returns null for anything that is not a github.com remote, so the caller can
// tell "not GitHub" apart from "no remote at all" and say so.
export function parseGitHubRemote(remoteUrl: string): RepoSlug | null {
    const trimmed = remoteUrl.trim();
    if (trimmed.includes(SCHEME_SEPARATOR)) {
        const { data: url } = tryCatchSync(() => new URL(trimmed));
        if (url === null || url.hostname !== GITHUB_HOST) {
            return null;
        }
        return parseSlugPath(url.pathname);
    }
    const scpMatch = SCP_LIKE_REMOTE.exec(trimmed);
    const host = scpMatch?.[1];
    const path = scpMatch?.[2];
    // Only the host folds: hostnames are case-insensitive and git preserves
    // whatever was typed, while owner and name travel on as GraphQL variables.
    if (host?.toLowerCase() !== GITHUB_HOST || path === undefined) {
        return null;
    }
    return parseSlugPath(path);
}

export async function resolveRepoSlug(repo: RepoRef): Promise<RepoSlug> {
    if (repo.github !== undefined) {
        const configured = parseSlugPath(repo.github);
        if (configured === null) {
            throw new GitHubError(
                GITHUB_ERROR_CODES.SLUG_INVALID,
                `Repo "${repo.name}" has github: "${repo.github}", which is not an "owner/name" slug.`
            );
        }
        return configured;
    }

    const { data: remoteUrl, error } = await tryCatch(
        runGit(["remote", "get-url", "origin"], repo.path)
    );
    if (error) {
        if (
            error instanceof ExtractError &&
            error.exitCode === NO_SUCH_REMOTE_EXIT_CODE
        ) {
            throw new GitHubError(
                GITHUB_ERROR_CODES.ORIGIN_MISSING,
                `Repo "${repo.name}" (${repo.path}) ${ORIGIN_MISSING_CAUSE}`,
                {
                    cause: error,
                    artifactMessage: `Repo "${repo.name}" ${ORIGIN_MISSING_CAUSE}`,
                }
            );
        }
        throw error;
    }

    const slug = parseGitHubRemote(remoteUrl);
    if (slug === null) {
        // The message exists to show which host was found, so the host and path
        // stay; a https://user:token@host remote would otherwise put its
        // credential on stderr, where CI captures it.
        const shown = remoteUrl.trim().replace(URL_USERINFO, REDACTED_USERINFO);
        throw new GitHubError(
            GITHUB_ERROR_CODES.ORIGIN_NOT_GITHUB,
            `Repo "${repo.name}" has an origin remote (${shown}) ${ORIGIN_NOT_GITHUB_CAUSE}`,
            {
                artifactMessage: `Repo "${repo.name}" has an origin remote ${ORIGIN_NOT_GITHUB_CAUSE}`,
            }
        );
    }
    return slug;
}
