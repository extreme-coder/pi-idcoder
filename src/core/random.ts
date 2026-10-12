/** Deterministic PRNG (mulberry32) so sampling, k-means seeding, and A/B ordering are reproducible. */
export class Rng {
	private state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	next(): number {
		this.state = (this.state + 0x6d2b79f5) >>> 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	int(maxExclusive: number): number {
		return Math.floor(this.next() * maxExclusive);
	}

	shuffle<T>(items: readonly T[]): T[] {
		const out = [...items];
		for (let i = out.length - 1; i > 0; i--) {
			const j = this.int(i + 1);
			[out[i], out[j]] = [out[j]!, out[i]!];
		}
		return out;
	}

	sample<T>(items: readonly T[], k: number): T[] {
		return this.shuffle(items).slice(0, Math.min(k, items.length));
	}

	/** Derives an independent stream, e.g. one per cluster, from a label. */
	fork(label: string): Rng {
		let h = this.state ^ 0x9e3779b9;
		for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193);
		return new Rng(h >>> 0);
	}
}
