import type { Rng } from "../core/random.ts";
import { dot, type Matrix } from "../embeddings/vector.ts";

export interface KMeansResult {
	labels: Int32Array;
	centers: Float32Array;
	inertia: number;
	iterations: number;
}

export interface KMeansOptions {
	rng: Rng;
	nInit: number;
	maxIter?: number;
	tol?: number;
}

export interface MiniBatchOptions extends KMeansOptions {
	batchSize: number;
	maxNoImprovement?: number;
}

function squaredNorms(data: Float32Array, rows: number, dim: number): Float64Array {
	const out = new Float64Array(rows);
	for (let i = 0; i < rows; i++) out[i] = dot(data, i * dim, data, i * dim, dim);
	return out;
}

/** Assigns each row to its nearest center; returns inertia (sum of squared distances). */
function assign(m: Matrix, rowNorms: Float64Array, centers: Float32Array, k: number, labels: Int32Array): number {
	const { dim, data } = m;
	const centerNorms = squaredNorms(centers, k, dim);
	let inertia = 0;
	for (let i = 0; i < m.rows; i++) {
		let best = 0;
		let bestDist = Infinity;
		for (let c = 0; c < k; c++) {
			const d = rowNorms[i]! + centerNorms[c]! - 2 * dot(data, i * dim, centers, c * dim, dim);
			if (d < bestDist) {
				bestDist = d;
				best = c;
			}
		}
		labels[i] = best;
		inertia += Math.max(0, bestDist);
	}
	return inertia;
}

function squaredDistanceToCenter(m: Matrix, i: number, centers: Float32Array, c: number): number {
	let sum = 0;
	const { dim, data } = m;
	for (let d = 0; d < dim; d++) {
		const diff = data[i * dim + d]! - centers[c * dim + d]!;
		sum += diff * diff;
	}
	return sum;
}

/** k-means++ seeding: each new center is drawn with probability proportional to squared distance. */
export function kmeansPlusPlus(m: Matrix, k: number, rng: Rng, rowSubset?: readonly number[]): Float32Array {
	const rows = rowSubset ?? Array.from({ length: m.rows }, (_, i) => i);
	const { dim } = m;
	const centers = new Float32Array(k * dim);
	centers.set(m.row(rows[rng.int(rows.length)]!), 0);
	const closest = new Float64Array(rows.length).fill(Infinity);
	for (let c = 1; c < k; c++) {
		let total = 0;
		for (let r = 0; r < rows.length; r++) {
			const d = squaredDistanceToCenter(m, rows[r]!, centers, c - 1);
			if (d < closest[r]!) closest[r] = d;
			total += closest[r]!;
		}
		let pick = rows.length - 1;
		if (total > 0) {
			let target = rng.next() * total;
			for (let r = 0; r < rows.length; r++) {
				target -= closest[r]!;
				if (target <= 0) {
					pick = r;
					break;
				}
			}
		} else {
			pick = rng.int(rows.length);
		}
		centers.set(m.row(rows[pick]!), c * dim);
	}
	return centers;
}

function meanVariance(m: Matrix): number {
	const { rows, dim, data } = m;
	if (rows === 0) return 0;
	let total = 0;
	for (let d = 0; d < dim; d++) {
		let mean = 0;
		for (let i = 0; i < rows; i++) mean += data[i * dim + d]!;
		mean /= rows;
		let v = 0;
		for (let i = 0; i < rows; i++) v += (data[i * dim + d]! - mean) ** 2;
		total += v / rows;
	}
	return total / dim;
}

/** Moves the center of an empty cluster onto the point currently farthest from its own center. */
function relocateEmpty(m: Matrix, centers: Float32Array, labels: Int32Array, counts: Int32Array, k: number): void {
	for (let c = 0; c < k; c++) {
		if (counts[c]! > 0) continue;
		let far = -1;
		let farDist = -1;
		for (let i = 0; i < m.rows; i++) {
			if (counts[labels[i]!]! <= 1) continue;
			const d = squaredDistanceToCenter(m, i, centers, labels[i]!);
			if (d > farDist) {
				farDist = d;
				far = i;
			}
		}
		if (far === -1) continue;
		counts[labels[far]!]!--;
		labels[far] = c;
		counts[c] = 1;
		centers.set(m.row(far), c * m.dim);
	}
}

function lloyd(m: Matrix, k: number, init: Float32Array, maxIter: number, tolAbs: number): KMeansResult {
	const { rows, dim, data } = m;
	const rowNorms = squaredNorms(data, rows, dim);
	const centers = Float32Array.from(init);
	const labels = new Int32Array(rows);
	const sums = new Float64Array(k * dim);
	const counts = new Int32Array(k);
	let iterations = 0;
	for (; iterations < maxIter; iterations++) {
		assign(m, rowNorms, centers, k, labels);
		counts.fill(0);
		for (let i = 0; i < rows; i++) counts[labels[i]!]!++;
		relocateEmpty(m, centers, labels, counts, k);
		sums.fill(0);
		for (let i = 0; i < rows; i++) {
			const c = labels[i]!;
			for (let d = 0; d < dim; d++) sums[c * dim + d] = sums[c * dim + d]! + data[i * dim + d]!;
		}
		let shift = 0;
		for (let c = 0; c < k; c++) {
			if (counts[c] === 0) continue;
			for (let d = 0; d < dim; d++) {
				const next = sums[c * dim + d]! / counts[c]!;
				shift += (next - centers[c * dim + d]!) ** 2;
				centers[c * dim + d] = next;
			}
		}
		if (shift <= tolAbs) {
			iterations++;
			break;
		}
	}
	const inertia = assign(m, rowNorms, centers, k, labels);
	return { labels, centers, inertia, iterations };
}

function validateK(m: Matrix, k: number): void {
	if (!Number.isInteger(k) || k < 1) throw new Error(`k must be a positive integer, got ${k}`);
	if (k > m.rows) throw new Error(`k=${k} exceeds the number of points (${m.rows})`);
}

/** Lloyd's k-means with k-means++ seeding; keeps the lowest-inertia run of `nInit`. */
export function kmeans(m: Matrix, k: number, options: KMeansOptions): KMeansResult {
	validateK(m, k);
	const tolAbs = (options.tol ?? 1e-4) * meanVariance(m);
	let best: KMeansResult | undefined;
	for (let run = 0; run < options.nInit; run++) {
		const result = lloyd(m, k, kmeansPlusPlus(m, k, options.rng), options.maxIter ?? 300, tolAbs);
		if (!best || result.inertia < best.inertia) best = result;
	}
	return best!;
}

/** Mini-batch k-means (Sculley 2010) for large inputs, with per-center learning rates and early stopping. */
export function miniBatchKmeans(m: Matrix, k: number, options: MiniBatchOptions): KMeansResult {
	validateK(m, k);
	const { rows, dim, data } = m;
	const batchSize = Math.min(options.batchSize, rows);
	const steps = Math.ceil(((options.maxIter ?? 100) * rows) / batchSize);
	const maxNoImprovement = options.maxNoImprovement ?? 10;
	const rowNorms = squaredNorms(data, rows, dim);
	let best: KMeansResult | undefined;

	for (let run = 0; run < options.nInit; run++) {
		const initRows = options.rng.sample(
			Array.from({ length: rows }, (_, i) => i),
			Math.min(rows, Math.max(3 * batchSize, k)),
		);
		const centers = kmeansPlusPlus(m, k, options.rng, initRows);
		const counts = new Float64Array(k);
		let ewa: number | undefined;
		let bestEwa = Infinity;
		let stale = 0;
		for (let step = 0; step < steps; step++) {
			const batch = options.rng.sample(
				Array.from({ length: rows }, (_, i) => i),
				batchSize,
			);
			const centerNorms = squaredNorms(centers, k, dim);
			let batchInertia = 0;
			const batchLabels = batch.map((i) => {
				let bestC = 0;
				let bestDist = Infinity;
				for (let c = 0; c < k; c++) {
					const d = rowNorms[i]! + centerNorms[c]! - 2 * dot(data, i * dim, centers, c * dim, dim);
					if (d < bestDist) {
						bestDist = d;
						bestC = c;
					}
				}
				batchInertia += Math.max(0, bestDist);
				return bestC;
			});
			batch.forEach((i, b) => {
				const c = batchLabels[b]!;
				counts[c]!++;
				const eta = 1 / counts[c]!;
				for (let d = 0; d < dim; d++) {
					centers[c * dim + d] = centers[c * dim + d]! + eta * (data[i * dim + d]! - centers[c * dim + d]!);
				}
			});
			const normalized = batchInertia / batchSize;
			const alpha = Math.min(1, (2 * batchSize) / (rows + 1));
			ewa = ewa === undefined ? normalized : ewa * (1 - alpha) + normalized * alpha;
			if (ewa < bestEwa) {
				bestEwa = ewa;
				stale = 0;
			} else if (++stale >= maxNoImprovement) {
				break;
			}
		}
		const labels = new Int32Array(rows);
		const inertia = assign(m, rowNorms, centers, k, labels);
		if (!best || inertia < best.inertia) best = { labels, centers, inertia, iterations: steps };
	}
	return best!;
}
