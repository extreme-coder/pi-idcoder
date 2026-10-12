/** Row-major dense matrix of L2-normalized embeddings; one contiguous buffer keeps the hot loops fast. */
export class Matrix {
	readonly rows: number;
	readonly dim: number;
	readonly data: Float32Array;

	constructor(rows: number, dim: number, data?: Float32Array) {
		this.rows = rows;
		this.dim = dim;
		this.data = data ?? new Float32Array(rows * dim);
		if (this.data.length !== rows * dim) throw new Error("Matrix buffer size mismatch");
	}

	static fromRows(rows: readonly ArrayLike<number>[]): Matrix {
		const dim = rows[0]?.length ?? 0;
		const m = new Matrix(rows.length, dim);
		rows.forEach((row, i) => {
			if (row.length !== dim) throw new Error(`Embedding ${i} has dimension ${row.length}, expected ${dim}`);
			m.data.set(row, i * dim);
		});
		return m;
	}

	row(i: number): Float32Array {
		return this.data.subarray(i * this.dim, (i + 1) * this.dim);
	}

	select(indices: readonly number[]): Matrix {
		const m = new Matrix(indices.length, this.dim);
		indices.forEach((src, dst) => {
			m.data.set(this.row(src), dst * this.dim);
		});
		return m;
	}
}

export function dot(a: Float32Array, aOffset: number, b: Float32Array, bOffset: number, dim: number): number {
	let sum = 0;
	for (let d = 0; d < dim; d++) sum += a[aOffset + d]! * b[bOffset + d]!;
	return sum;
}

export function normalizeInPlace(v: Float32Array | number[]): void {
	let norm = 0;
	for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
	norm = Math.max(Math.sqrt(norm), 1e-12);
	for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
}

export function normalizeRows(m: Matrix): Matrix {
	for (let i = 0; i < m.rows; i++) normalizeInPlace(m.row(i));
	return m;
}

/** Cosine similarity of row `i` against every row (rows must be normalized). */
export function similaritiesTo(m: Matrix, i: number): Float64Array {
	const out = new Float64Array(m.rows);
	const off = i * m.dim;
	for (let j = 0; j < m.rows; j++) out[j] = dot(m.data, off, m.data, j * m.dim, m.dim);
	return out;
}

/** Index of the most similar row of `targets` for each row of `queries` (both normalized). */
export function nearestRows(queries: Matrix, targets: Matrix): number[] {
	const out: number[] = [];
	for (let i = 0; i < queries.rows; i++) {
		let best = 0;
		let bestSim = -Infinity;
		for (let j = 0; j < targets.rows; j++) {
			const s = dot(queries.data, i * queries.dim, targets.data, j * targets.dim, queries.dim);
			if (s > bestSim) {
				bestSim = s;
				best = j;
			}
		}
		out.push(best);
	}
	return out;
}
