export const MS_PER_HOUR = 60 * 60 * 1000;

export function median(values: number[]): number | null {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle] ?? null;
    }
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
