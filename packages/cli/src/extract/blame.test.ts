import { expect, test } from "bun:test";
import { parseBlamePorcelain } from "./blame";

function commitBlock(
    sha: string,
    name: string,
    email: string,
    finalLine: number,
    content: string
): string {
    return [
        `${sha} ${finalLine} ${finalLine} 1`,
        `author ${name}`,
        `author-mail <${email}>`,
        "author-time 1700000000",
        "author-tz +0000",
        `committer ${name}`,
        `committer-mail <${email}>`,
        "committer-time 1700000000",
        "committer-tz +0000",
        "summary a change",
        "filename src/a.ts",
        `\t${content}`,
    ].join("\n");
}

test("tallies surviving lines per author email across line-porcelain blocks", () => {
    const output = [
        commitBlock(
            "1111111111111111111111111111111111111111",
            "Dev One",
            "dev-one@example.com",
            1,
            "const a = 1;"
        ),
        commitBlock(
            "2222222222222222222222222222222222222222",
            "Dev Two",
            "dev-two@example.com",
            2,
            "const b = 2;"
        ),
        commitBlock(
            "1111111111111111111111111111111111111111",
            "Dev One",
            "dev-one@example.com",
            3,
            "const c = 3;"
        ),
    ].join("\n");

    const tally = parseBlamePorcelain(output);

    expect(tally.get("dev-one@example.com")).toEqual({
        name: "Dev One",
        lines: 2,
    });
    expect(tally.get("dev-two@example.com")).toEqual({
        name: "Dev Two",
        lines: 1,
    });
});

test("returns an empty tally for empty blame output", () => {
    expect(parseBlamePorcelain("").size).toBe(0);
});
