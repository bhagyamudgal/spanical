export function parseSha256Sums(text: string): Record<string, string> {
    // Null-prototype object blocks __proto__/constructor pollution from a tampered file.
    const result: Record<string, string> = Object.create(null);
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
        if (!match) continue;
        const [, hash, filename] = match;
        if (!hash || !filename) continue;
        const name = filename.trim();
        if (Object.prototype.hasOwnProperty.call(result, name)) {
            throw new Error(`Duplicate SHA256SUMS entry for ${name}`);
        }
        result[name] = hash.toLowerCase();
    }
    return result;
}
