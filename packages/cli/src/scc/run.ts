import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { tryCatch } from "@spanical/utils";
import { SCC_ERROR_CODES, SccError } from "./errors";

export type SccFileEntry = {
    path: string;
    language: string;
    code: number;
    complexity: number;
};

const sccFileSchema = z.object({
    Language: z.string(),
    Location: z.string(),
    Code: z.number(),
    Complexity: z.number(),
});

const sccOutputSchema = z.array(z.object({ Files: z.array(sccFileSchema) }));

export async function runScc(
    sccBinary: string,
    cwd: string
): Promise<SccFileEntry[]> {
    const result = await tryCatch(scanFiles(sccBinary, cwd));
    if (result.error) {
        if (result.error instanceof SccError) {
            throw result.error;
        }
        throw new SccError(
            SCC_ERROR_CODES.SCC_RUN_FAILED,
            `scc failed in ${cwd}: ${result.error.message}`,
            { cause: result.error }
        );
    }
    return result.data;
}

async function scanFiles(
    sccBinary: string,
    cwd: string
): Promise<SccFileEntry[]> {
    const proc = Bun.spawn([sccBinary, "--by-file", "--format", "json", "."], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    if (exitCode !== 0) {
        throw new SccError(
            SCC_ERROR_CODES.SCC_RUN_FAILED,
            `scc exited ${exitCode} in ${cwd}: ${stderr.trim()}`
        );
    }

    const languages = sccOutputSchema.parse(JSON.parse(stdout));
    return languages.flatMap((language) =>
        language.Files.map((file) => ({
            path: repoRelativePath(cwd, file.Location),
            language: file.Language,
            code: file.Code,
            complexity: file.Complexity,
        }))
    );
}

function repoRelativePath(cwd: string, location: string): string {
    return isAbsolute(location) ? relative(cwd, location) : location;
}
