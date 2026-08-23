type Success<T> = { data: T; error: null };
type Failure = { data: null; error: Error };
type Result<T> = Success<T> | Failure;

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

export async function tryCatch<T>(
    promiseOrThunk: Promise<T> | (() => Promise<T>)
): Promise<Result<T>> {
    try {
        const data = await (typeof promiseOrThunk === "function"
            ? promiseOrThunk()
            : promiseOrThunk);
        return { data, error: null };
    } catch (error) {
        return { data: null, error: ensureError(error) };
    }
}
