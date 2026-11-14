export interface DocLink {
    id: string;
    title: string;
    order: number;
}

/** Docs in sidebar order, with the pages before and after `id`. */
export function docsNavigation<T extends DocLink>(
    docs: readonly T[],
    id: string,
): { ordered: T[]; previous: T | null; next: T | null } {
    const ordered = [...docs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const index = ordered.findIndex((doc) => doc.id === id);
    return {
        ordered,
        previous: index > 0 ? (ordered[index - 1] ?? null) : null,
        next: index >= 0 ? (ordered[index + 1] ?? null) : null,
    };
}

/** Compares CLI versions like `0.10.0` and `0.9.1`, newest first. */
export function newestVersionFirst(a: string, b: string): number {
    const parts = (version: string) => version.split('.').map(Number);
    const [left, right] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (right[i] ?? 0) - (left[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
