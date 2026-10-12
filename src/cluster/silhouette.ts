import type { Rng } from "../core/random.ts";
import { dot, type Matrix } from "../embeddings/vector.ts";

/**
 * Mean silhouette coefficient over a fixed random sample (euclidean distance), like
 * `sklearn.metrics.silhouette_score(X, labels, sample_size=...)`. The pairwise distances of the
 * sample do not depend on the clustering, so they are computed once and reused for every k.
 */
export class SilhouetteScorer {
	readonly sample: readonly number[];
	private readonly distances: Float32Array;

	constructor(m: Matrix, sampleSize: number, rng: Rng) {
		const all = Array.from({ length: m.rows }, (_, i) => i);
		this.sample = sampleSize >= m.rows ? all : rng.sample(all, sampleSize).sort((a, b) => a - b);
		const n = this.sample.length;
		this.distances = new Float32Array((n * (n - 1)) / 2);
		const norms = this.sample.map((i) => dot(m.data, i * m.dim, m.data, i * m.dim, m.dim));
		for (let a = 1; a < n; a++) {
			const ia = this.sample[a]!;
			for (let b = 0; b < a; b++) {
				const ib = this.sample[b]!;
				const sq = norms[a]! + norms[b]! - 2 * dot(m.data, ia * m.dim, m.data, ib * m.dim, m.dim);
				this.distances[(a * (a - 1)) / 2 + b] = Math.sqrt(Math.max(0, sq));
			}
		}
	}

	private distance(a: number, b: number): number {
		if (a === b) return 0;
		return a > b ? this.distances[(a * (a - 1)) / 2 + b]! : this.distances[(b * (b - 1)) / 2 + a]!;
	}

	/** Returns NaN when the sampled labels do not form between 2 and n-1 clusters (undefined score). */
	score(labels: ArrayLike<number>): number {
		const n = this.sample.length;
		const sampleLabels = this.sample.map((i) => labels[i]!);
		const clusterIds = [...new Set(sampleLabels)];
		if (clusterIds.length < 2 || clusterIds.length > n - 1) return Number.NaN;
		const position = new Map(clusterIds.map((c, i) => [c, i]));
		const sizes = new Float64Array(clusterIds.length);
		for (const label of sampleLabels) sizes[position.get(label)!]!++;

		let total = 0;
		const sums = new Float64Array(clusterIds.length);
		for (let a = 0; a < n; a++) {
			sums.fill(0);
			for (let b = 0; b < n; b++) {
				if (a !== b) sums[position.get(sampleLabels[b]!)!]! += this.distance(a, b);
			}
			const own = position.get(sampleLabels[a]!)!;
			if (sizes[own]! <= 1) continue;
			const intra = sums[own]! / (sizes[own]! - 1);
			let nearest = Infinity;
			for (let c = 0; c < clusterIds.length; c++) {
				if (c !== own && sizes[c]! > 0) nearest = Math.min(nearest, sums[c]! / sizes[c]!);
			}
			const denom = Math.max(intra, nearest);
			total += denom > 0 ? (nearest - intra) / denom : 0;
		}
		return total / n;
	}
}
