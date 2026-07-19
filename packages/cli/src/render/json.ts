const JSON_INDENT = 4;

export function renderJson(data: unknown): string {
    return JSON.stringify(data, null, JSON_INDENT);
}
