import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clusterByEmbedding, kRange, remapCodesPerReview, selectK } from "../../src/cluster/axial-embedding.ts";
import { deduplicateCodes } from "../../src/cluster/dedup.ts";
import { kmeans, kmeansPlusPlus, miniBatchKmeans } from "../../src/cluster/kmeans.ts";
import { SilhouetteScorer } from "../../src/cluster/silhouette.ts";
import { resolveConfig } from "../../src/config/load.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { Rng } from "../../src/core/random.ts";
import { Matrix, nearestRows, normalizeRows, similaritiesTo } from "../../src/embeddings/vector.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";

const reference = JSON.parse(readFileSync(new URL("../fixtures/reference/sklearn.json", import.meta.url), "utf8")) as {
	silhouette: { X: number[][]; cases: Array<{ labels: number[]; score: number }> };
	blobs: { X: number[][]; y: number[]; inertia: number; silhouette_by_k: Record<string, number> };
};
const clustering = resolveConfig({ study: { researchQuestion: "q", data: "d.csv" } }).clustering;

/** Adjusted for label permutation: fraction of point pairs on which two partitions agree. */
function randIndex(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let agree = 0;
	let total = 0;
	for (let i = 0; i < a.length; i++) {
		for (let j = i + 1; j < a.length; j++) {
			total++;
			if ((a[i] === a[j]) === (b[i] === b[j])) agree++;
		}
	}
	return agree / total;
}

describe("SilhouetteScorer", () => {
	it("matches sklearn.metrics.silhouette_score on random labelings", () => {
		const m = Matrix.fromRows(reference.silhouette.X);
		const scorer = new SilhouetteScorer(m, 10_000, new Rng(1));
		for (const c of reference.silhouette.cases) {
			expect(scorer.score(c.labels)).toBeCloseTo(c.score, 5);
		}
	});

	it("is undefined for one cluster or all singletons", () => {
		const m = Matrix.fromRows([
			[0, 1],
			[1, 0],
			[1, 1],
		]);
		const scorer = new SilhouetteScorer(m, 100, new Rng(1));
		expect(scorer.score([0, 0, 0])).toBeNaN();
		expect(scorer.score([0, 1, 2])).toBeNaN();
	});

	it("samples a subset when requested", () => {
		const m = Matrix.fromRows(reference.blobs.X);
		const scorer = new SilhouetteScorer(m, 30, new Rng(4));
		expect(scorer.sample).toHaveLength(30);
		expect(scorer.score(reference.blobs.y)).toBeGreaterThan(0.6);
	});
});

describe("kmeans", () => {
	const m = Matrix.fromRows(reference.blobs.X);

	it("recovers well-separated blobs with sklearn-level inertia", () => {
		const result = kmeans(m, 4, { rng: new Rng(11), nInit: 10 });
		expect(result.inertia).toBeCloseTo(reference.blobs.inertia, 3);
		expect(randIndex(result.labels, reference.blobs.y)).toBe(1);
	});

	it("is deterministic for a seed", () => {
		const a = kmeans(m, 3, { rng: new Rng(5), nInit: 2 });
		const b = kmeans(m, 3, { rng: new Rng(5), nInit: 2 });
		expect(Array.from(a.labels)).toEqual(Array.from(b.labels));
	});

	it("relocates empty clusters onto distant points", () => {
		const points = Matrix.fromRows([
			[1, 0],
			[0.99, 0.01],
			[0, 1],
			[0.01, 0.99],
			[0.7, 0.7],
		]);
		for (let seed = 0; seed < 20; seed++) {
			const result = kmeans(points, 3, { rng: new Rng(seed), nInit: 1 });
			expect(new Set(result.labels).size).toBe(3);
		}
	});

	it("degrades gracefully when there are fewer distinct points than k", () => {
		const dupes = Matrix.fromRows([
			[1, 0],
			[1, 0],
			[0, 1],
		]);
		const result = kmeans(dupes, 3, { rng: new Rng(2), nInit: 3 });
		expect(result.inertia).toBeCloseTo(0);
		expect(new Set(result.labels).size).toBe(2);
	});

	it("rejects invalid k", () => {
		expect(() => kmeans(m, 0, { rng: new Rng(1), nInit: 1 })).toThrow();
		expect(() => kmeans(m, 1000, { rng: new Rng(1), nInit: 1 })).toThrow(/exceeds/);
	});

	it("seeds k-means++ with distinct points", () => {
		const centers = kmeansPlusPlus(m, 4, new Rng(3));
		const rows = Array.from({ length: 4 }, (_, i) => centers.slice(i * m.dim, (i + 1) * m.dim).join(","));
		expect(new Set(rows).size).toBe(4);
	});

	it("mini-batch k-means approximates full k-means on blobs", () => {
		const result = miniBatchKmeans(m, 4, { rng: new Rng(7), nInit: 3, batchSize: 32 });
		expect(randIndex(result.labels, reference.blobs.y)).toBeGreaterThan(0.95);
		expect(result.inertia).toBeLessThan(reference.blobs.inertia * 1.2);
	});
});

describe("selectK", () => {
	it("picks the k sklearn's silhouette sweep prefers", () => {
		const m = Matrix.fromRows(reference.blobs.X);
		const expectedBest = Number(Object.entries(reference.blobs.silhouette_by_k).sort((a, b) => b[1] - a[1])[0]![0]);
		const selection = selectK(
			m.rows,
			(k) => kmeans(m, k, { rng: new Rng(k), nInit: 10 }),
			new SilhouetteScorer(m, 10_000, new Rng(1)),
			{ ...clustering, kMin: 2, kMaxCap: 7, kMaxDivisor: 1 },
		);
		expect(selection.k).toBe(expectedBest);
		// beyond the true k, k-means local optima legitimately differ from sklearn's run
		for (const k of [2, 3, 4, 5]) {
			expect(selection.scores[k]).toBeCloseTo(reference.blobs.silhouette_by_k[String(k)]!, 6);
		}
	});

	it("bounds the k range like the original pipeline and never exceeds n - 1", () => {
		expect(kRange(1000, clustering)).toEqual([5, 50]);
		expect(kRange(60, clustering)).toEqual([5, 20]);
		expect(kRange(9, clustering)).toEqual([5, 6]);
		expect(kRange(5, clustering)).toEqual([4, 4]);
	});
});

describe("vector helpers", () => {
	it("computes similarities and nearest rows", () => {
		const m = normalizeRows(
			Matrix.fromRows([
				[1, 0],
				[0, 2],
				[1, 1],
			]),
		);
		expect(similaritiesTo(m, 0)[1]).toBeCloseTo(0);
		expect(nearestRows(m.select([2, 0]), m.select([0, 1]))).toEqual([0, 0]);
		expect(() => Matrix.fromRows([[1], [1, 2]])).toThrow(/dimension/);
	});
});

describe("deduplicateCodes", () => {
	it("merges exact duplicates case-insensitively and keeps the first spelling", async () => {
		const result = await deduplicateCodes(["Slow load", "slow load ", "SLOW LOAD"], new HashingEmbedder(), 0.95);
		expect(result.codes).toEqual(["Slow load"]);
		expect(result.canonicalOf).toEqual({
			"Slow load": "Slow load",
			"slow load ": "Slow load",
			"SLOW LOAD": "Slow load",
		});
	});

	it("merges near-duplicates above the threshold only", async () => {
		const codes = ["laggy multiplayer matchmaking", "matchmaking multiplayer laggy", "intuitive inventory controls"];
		const result = await deduplicateCodes(codes, new HashingEmbedder(), 0.95);
		expect(result.codes).toEqual(["intuitive inventory controls", "laggy multiplayer matchmaking"]);
		expect(result.canonicalOf["matchmaking multiplayer laggy"]).toBe("laggy multiplayer matchmaking");
		const strict = await deduplicateCodes(codes, new HashingEmbedder(), 1.01);
		expect(strict.codes).toHaveLength(3);
	});
});

describe("clusterByEmbedding", () => {
	const themes = {
		crash: ["crash on launch", "crash in boss fight", "crash after update", "crash on save"],
		price: ["price too high", "price of cosmetic items", "high price for dlc", "expensive price tier"],
		story: ["boring story pacing", "story feels rushed", "weak story ending", "story characters flat"],
	};
	const all = Object.values(themes).flat();

	it("groups codes by theme and remaps codes per review", async () => {
		const deps = {
			embedder: new HashingEmbedder(),
			config: { ...clustering, kMin: 2, kMaxCap: 6 },
			rng: new Rng(1),
			logger: silentLogger,
		};
		const { file, summary } = await clusterByEmbedding(
			[...all, "Price too high"],
			[[1, ["Price too high", "price too high"]]],
			deps,
		);
		expect(file.clustering_method).toBe("embedding");
		expect(file.k).toBe(Object.keys(file.cluster_to_codes).length);
		expect(file.labels).toHaveLength(file.all_codes.length);
		const clusterOf = (code: string) =>
			Object.entries(file.cluster_to_codes).find(([, codes]) => codes.includes(code))![0];
		for (const group of Object.values(themes)) {
			expect(new Set(group.map(clusterOf)).size).toBe(1);
		}
		expect(file.codes_per_review).toEqual([[1, ["price too high"]]]);
		expect(summary).toContain("Axial coding (embed + K-means)");
	});

	it("puts tiny inputs in a single cluster", async () => {
		const { file, summary } = await clusterByEmbedding(["a b", "c d"], [], {
			embedder: new HashingEmbedder(),
			config: clustering,
			rng: new Rng(1),
			logger: silentLogger,
		});
		expect(file.cluster_to_codes).toEqual({ "0": ["a b", "c d"] });
		expect(file.k).toBe(1);
		expect(summary).toContain("placed in 1 cluster");
	});

	it("fails loudly with no codes", async () => {
		await expect(
			clusterByEmbedding([], [], {
				embedder: new HashingEmbedder(),
				config: clustering,
				rng: new Rng(1),
				logger: silentLogger,
			}),
		).rejects.toThrow(/No codes/);
	});

	it("remaps per-review codes without duplicates", () => {
		expect(remapCodesPerReview([[3, ["a", "A", "b"]]], { a: "a", A: "a" })).toEqual([[3, ["a", "b"]]]);
	});
});
