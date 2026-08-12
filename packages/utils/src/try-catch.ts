type Success<T> = { data: T; error: null };
type Failure = { data: null; error: Error };
type Result<T> = Success<T> | Failure;
type RetryOptions = {
    maxRetries: number;
    delayMs?: number | ((error: Error, retry: number) => number);
    onRetry?: (error: Error, retry: number, delayMs: number) => void;
    shouldRetry?: (error: Error) => boolean;
};

function ensureError(value: unknown): Error {
    if (value instanceof Error) return value;

    let message: string | undefined;
    try {
        message = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        message = String(value);
    }

    return new Error(message ?? String(value), { cause: value });
}

async function tryCatch<T>(promise: Promise<T>): Promise<Result<T>> {
    try {
        const data = await promise;
        return { data, error: null };
    } catch (error) {
        return { data: null, error: ensureError(error) };
    }
}

async function callOperation<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
}

async function delay(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
        return;
    }
    await Bun.sleep(delayMs);
}

async function retryOperation<T>(
    operation: () => Promise<T>,
    options: RetryOptions
): Promise<T> {
    let result = await tryCatch(callOperation(operation));
    let retry = 0;
    while (result.error !== null) {
        if (
            retry >= options.maxRetries ||
            !(options.shouldRetry?.(result.error) ?? true)
        ) {
            throw result.error;
        }
        retry += 1;
        const delayMs =
            typeof options.delayMs === "function"
                ? options.delayMs(result.error, retry)
                : (options.delayMs ?? 0);
        options.onRetry?.(result.error, retry, delayMs);
        await delay(delayMs);
        result = await tryCatch(callOperation(operation));
    }
    return result.data;
}

async function tryCatchRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions
): Promise<Result<T>> {
    return tryCatch(retryOperation(operation, options));
}

async function tryCatchWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
): Promise<Result<T>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
            () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
            timeoutMs
        );
    });

    const result = await tryCatch(Promise.race([promise, timeoutPromise]));
    if (timeout !== undefined) {
        clearTimeout(timeout);
    }
    return result;
}

function tryCatchSync<T>(fn: () => T): Result<T> {
    try {
        const data = fn();
        return { data, error: null };
    } catch (error) {
        return { data: null, error: ensureError(error) };
    }
}

export { tryCatch, tryCatchRetry, tryCatchSync, tryCatchWithTimeout };
export type { Result, RetryOptions };
