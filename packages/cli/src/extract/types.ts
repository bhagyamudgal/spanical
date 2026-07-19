export type ParsedCoAuthor = { name: string; email: string };

export type ParsedFileChange = {
    path: string;
    added: number | null;
    deleted: number | null;
    isBinary: boolean;
};

export type ParsedCommit = {
    sha: string;
    authorEmail: string;
    authorName: string;
    authoredAt: number;
    coAuthors: ParsedCoAuthor[];
    files: ParsedFileChange[];
};
