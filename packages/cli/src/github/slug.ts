import { tryCatch, tryCatchSync } from "@spanical/utils";
import { ExtractError } from "../extract/errors";
import { runGit } from "../extract/git";
import { GITHUB_ERROR_CODES, GitHubError } from "./errors";

const GITHUB_HOST = "github.com";
const SCHEME_SEPARATOR = "://";
const SCP_LIKE_REMOTE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;
const GIT_SUFFIX = ".git";
const SLUG_SEGMENT_COUNT = 2;
const NO_SUCH_REMOTE_EXIT_CODE = 2;

export type RepoSlug = { owner: string; name: string };

type RepoRef = { name: string; path: string; github?: string };

export function formatSlug(slug: RepoSlug): string {
    return `${slug.owner}/${slug.name}`;
}

export function parseSlugPath(path: string): RepoSlug | null {
    const segments = path
        .split("/")
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment));
    if (segments.length !== SLUG_SEGMENT_COUNT) {
        return null;
    }
    const [owner, lastSegment] = segments;
    if (owner === undefined || lastSegment === undefined) {
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
    if (host !== GITHUB_HOST || path === undefined) {
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
                `Repo "${repo.name}" (${repo.path}) has no "origin" remote, so its GitHub repository cannot be determined. Add an origin remote, or set github: "owner/name" on that repo entry in spanical.config.ts.`,
                { cause: error }
            );
        }
        throw error;
    }

    const slug = parseGitHubRemote(remoteUrl);
    if (slug === null) {
        throw new GitHubError(
            GITHUB_ERROR_CODES.ORIGIN_NOT_GITHUB,
            `Repo "${repo.name}" has an origin remote (${remoteUrl.trim()}) that is not a ${GITHUB_HOST} repository. Set github: "owner/name" on that repo entry in spanical.config.ts.`
        );
    }
    return slug;
}
