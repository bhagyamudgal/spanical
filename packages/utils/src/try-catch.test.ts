import { expect, test } from "bun:test";
import { tryCatch, tryCatchSync } from "./try-catch";

test("tryCatch resolves data on success", async () => {
    const result = await tryCatch(Promise.resolve(42));
    expect(result.data).toBe(42);
    expect(result.error).toBeNull();
});

test("tryCatch returns an Error on rejection", async () => {
    const result = await tryCatch(Promise.reject(new Error("boom")));
    expect(result.data).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("boom");
});

test("tryCatch returns the original Error instance unwrapped", async () => {
    const original = new TypeError("boom");
    const result = await tryCatch(Promise.reject(original));
    expect(result.error).toBe(original);
});

test("tryCatch wraps string rejections", async () => {
    const result = await tryCatch(Promise.reject("plain string"));
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe("plain string");
});

test("tryCatch preserves context for object rejections", async () => {
    const rejection = { code: "ENOENT", path: "/x" };
    const result = await tryCatch(Promise.reject(rejection));
    expect(result.error?.message).not.toBe("[object Object]");
    expect(result.error?.message).toContain("ENOENT");
    expect(result.error?.cause).toEqual(rejection);
});

test("tryCatch keeps null and undefined rejections legible", async () => {
    const nullResult = await tryCatch(Promise.reject(null));
    expect(nullResult.error?.cause).toBeNull();

    const undefinedResult = await tryCatch(Promise.reject(undefined));
    expect(undefinedResult.error?.message).toBe("undefined");
});

test("tryCatchSync returns data on success", () => {
    const result = tryCatchSync(() => JSON.parse('{"ok":true}'));
    expect(result.data).toEqual({ ok: true });
    expect(result.error).toBeNull();
});

test("tryCatchSync returns an Error on throw", () => {
    const result = tryCatchSync(() => {
        throw new Error("sync boom");
    });
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe("sync boom");
});

test("tryCatchSync wraps non-Error throws with context", () => {
    const result = tryCatchSync(() => {
        throw { code: "EPARSE" };
    });
    expect(result.error?.message).toContain("EPARSE");
    expect(result.error?.cause).toEqual({ code: "EPARSE" });
});
