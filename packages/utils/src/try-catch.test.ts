import { expect, test } from "bun:test";
import {
    tryCatch,
    tryCatchRetry,
    tryCatchSync,
    tryCatchWithTimeout,
} from "./try-catch";

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

test("tryCatchWithTimeout returns an error when the promise does not settle", async () => {
    const result = await tryCatchWithTimeout(
        new Promise<never>(() => undefined),
        10
    );

    expect(result.data).toBeNull();
    expect(result.error?.message).toBe("Operation timed out after 10ms");
});

test("tryCatchWithTimeout returns data when the promise settles in time", async () => {
    const result = await tryCatchWithTimeout(Promise.resolve(42), 100);

    expect(result.data).toBe(42);
    expect(result.error).toBeNull();
});

test("tryCatchRetry returns data after a later attempt succeeds", async () => {
    let attempts = 0;
    const result = await tryCatchRetry(
        () => {
            attempts += 1;
            return attempts < 3
                ? Promise.reject(new Error("try again"))
                : Promise.resolve(42);
        },
        { maxRetries: 3 }
    );

    expect(attempts).toBe(3);
    expect(result.data).toBe(42);
    expect(result.error).toBeNull();
});

test("tryCatchRetry returns the final error after exhausting retries", async () => {
    let attempts = 0;
    const result = await tryCatchRetry(
        () => {
            attempts += 1;
            throw new Error(`failure ${attempts}`);
        },
        { maxRetries: 2 }
    );

    expect(attempts).toBe(3);
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe("failure 3");
});

test("tryCatchRetry returns errors thrown by retry callbacks", async () => {
    const callbackError = new Error("retry notice failed");
    const result = await tryCatchRetry(
        () => Promise.reject(new Error("operation failed")),
        {
            maxRetries: 1,
            onRetry() {
                throw callbackError;
            },
        }
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe(callbackError);
});

test("tryCatchRetry returns errors thrown while classifying a retry", async () => {
    const callbackError = new Error("retry classification failed");
    const result = await tryCatchRetry(
        () => Promise.reject(new Error("operation failed")),
        {
            maxRetries: 1,
            shouldRetry() {
                throw callbackError;
            },
        }
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe(callbackError);
});

test("tryCatchRetry passes the one-based retry number to delay callbacks", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const result = await tryCatchRetry(
        () => {
            attempts += 1;
            return attempts < 3
                ? Promise.reject(new Error("try again"))
                : Promise.resolve(42);
        },
        {
            maxRetries: 3,
            delayMs(_error, retry) {
                retries.push(retry);
                return 0;
            },
        }
    );

    expect(result.data).toBe(42);
    expect(retries).toEqual([1, 2]);
});
