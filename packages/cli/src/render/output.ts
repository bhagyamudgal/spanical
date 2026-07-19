import { writeFileSync } from "node:fs";
import { tryCatchSync } from "@spanical/utils";

export function writeRendered(content: string, out: string | null): void {
    if (out === null) {
        process.stdout.write(`${content}\n`);
        return;
    }

    const { error } = tryCatchSync(() => writeFileSync(out, `${content}\n`));
    if (error) {
        process.stderr.write(`Failed to write ${out}: ${error.message}\n`);
        throw error;
    }
}
