import type { Embedder } from "../embeddings/embedder.ts";
import { dot } from "../embeddings/vector.ts";

export interface DedupResult {
	/** Sorted canonical codes. */
	codes: string[];
	/** Every original code string mapped to its canonical representative. */
	canonicalOf: Record<string, string>;
}

class UnionFind {
	private readonly parent: Int32Array;

	constructor(n: number) {
		this.parent = Int32Array.from({ length: n }, (_, i) => i);
	}

	find(x: number): number {
		while (this.parent[x] !== x) {
			this.parent[x] = this.parent[this.parent[x]!]!;
			x = this.parent[x]!;
		}
		return x;
	}

	union(a: number, b: number): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent[rb] = ra;
	}
}

/**
 * Exact (case-insensitive, trimmed) dedup, then merges near-duplicates whose embedding cosine
 * similarity reaches `threshold` into equivalence classes with one canonical representative.
 */
export async function deduplicateCodes(
	allCodes: readonly string[],
	embedder: Embedder,
	threshold: number,
	signal?: AbortSignal,
): Promise<DedupResult> {
	const exactCanonical = new Map<string, string>();
	for (const code of allCodes) {
		const key = code.trim().toLowerCase();
		if (!exactCanonical.has(key)) exactCanonical.set(key, code.trim());
	}
	const unique = [...exactCanonical.values()];

	if (unique.length < 2) {
		return {
			codes: unique,
			canonicalOf: Object.fromEntries(allCodes.map((c) => [c, exactCanonical.get(c.trim().toLowerCase())!])),
		};
	}

	const m = await embedder.embed(unique, signal);
	const uf = new UnionFind(unique.length);
	for (let i = 0; i < unique.length; i++) {
		for (let j = i + 1; j < unique.length; j++) {
			if (dot(m.data, i * m.dim, m.data, j * m.dim, m.dim) >= threshold) uf.union(i, j);
		}
	}

	const canonicalByIndex = unique.map((_, i) => unique[uf.find(i)]!);
	const byUnique = new Map(unique.map((code, i) => [code, canonicalByIndex[i]!]));
	const canonicalOf: Record<string, string> = {};
	for (const code of allCodes) {
		const exact = exactCanonical.get(code.trim().toLowerCase()) ?? code.trim();
		canonicalOf[code] = byUnique.get(exact) ?? exact;
	}
	return { codes: [...new Set(canonicalByIndex)].sort(), canonicalOf };
}
