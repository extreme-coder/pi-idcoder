import type { Embedder } from "../../src/embeddings/embedder.ts";
import { Matrix, normalizeRows } from "../../src/embeddings/vector.ts";

function hash(word: string): number {
	let h = 2166136261;
	for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
	return h >>> 0;
}

/**
 * Bag-of-words hashing embedder: texts sharing words are similar, identical texts are identical,
 * and unrelated texts are near-orthogonal. Deterministic and offline.
 */
export class HashingEmbedder implements Embedder {
	readonly calls: string[][] = [];
	private readonly dim: number;

	constructor(dim = 256) {
		this.dim = dim;
	}

	async embed(texts: readonly string[]): Promise<Matrix> {
		this.calls.push([...texts]);
		if (texts.length === 0) return new Matrix(0, 0);
		const m = new Matrix(texts.length, this.dim);
		texts.forEach((text, i) => {
			const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? ["empty"];
			for (const word of words) {
				const h = hash(word);
				m.data[i * this.dim + (h % this.dim)]! += 1;
				m.data[i * this.dim + ((h >>> 8) % this.dim)]! += 0.5;
			}
		});
		return normalizeRows(m);
	}
}
