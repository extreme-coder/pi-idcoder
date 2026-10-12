import type { ClusteredCodesFile, ReviewCodes } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import type { Logger } from "../core/logger.ts";
import type { Rng } from "../core/random.ts";
import type { Embedder } from "../embeddings/embedder.ts";
import { deduplicateCodes } from "./dedup.ts";
import { type KMeansResult, kmeans, miniBatchKmeans } from "./kmeans.ts";
import { SilhouetteScorer } from "./silhouette.ts";

export interface AxialResult {
	file: ClusteredCodesFile;
	summary: string;
}

export interface KSelection {
	k: number;
	silhouette: number;
	scores: Record<number, number>;
}

/** Re-expresses each review's codes in canonical form, de-duplicated within the review. */
export function remapCodesPerReview(
	codesPerReview: readonly ReviewCodes[],
	canonicalOf: Record<string, string>,
): ReviewCodes[] {
	return codesPerReview.map(([reviewId, codes]) => {
		const seen = new Set<string>();
		const row: string[] = [];
		for (const code of codes) {
			const canonical = canonicalOf[code] ?? code;
			if (!seen.has(canonical)) {
				seen.add(canonical);
				row.push(canonical);
			}
		}
		return [reviewId, row];
	});
}

export function kRange(n: number, clustering: IdcoderConfig["clustering"]): [number, number] {
	const kMax = Math.min(clustering.kMaxCap, Math.max(clustering.kMin + 1, Math.floor(n / clustering.kMaxDivisor)));
	// silhouette is undefined unless 2 <= k <= n - 1
	return [Math.min(clustering.kMin, n - 1), Math.min(kMax, n - 1)];
}

export function axialSummary(header: string, clusterToCodes: Record<string, string[]>, maxPerCluster?: number): string {
	const lines = [header, ""];
	for (const [cid, codes] of Object.entries(clusterToCodes)) {
		lines.push(`Cluster ${cid}:`);
		const shown = maxPerCluster === undefined ? codes : codes.slice(0, maxPerCluster);
		for (const code of shown) lines.push(`  - ${code}`);
		if (maxPerCluster !== undefined && codes.length > maxPerCluster) {
			lines.push(`  - ... and ${codes.length - maxPerCluster} more`);
		}
		lines.push("");
	}
	return lines.join("\n").trim();
}

/**
 * Paper §3.1 "Clustering": exact + near-duplicate merge, L2-normalized embeddings, K-means with
 * K chosen by silhouette over a bounded range (mini-batch above the size threshold).
 */
export async function clusterByEmbedding(
	allCodes: readonly string[],
	codesPerReview: readonly ReviewCodes[],
	deps: { embedder: Embedder; config: IdcoderConfig["clustering"]; rng: Rng; logger: Logger; signal?: AbortSignal },
): Promise<AxialResult> {
	const { embedder, config, rng, logger, signal } = deps;
	if (allCodes.length === 0) throw new Error("No codes to cluster: open coding produced no codes.");

	const dedup = await deduplicateCodes(allCodes, embedder, config.nearDuplicateThreshold, signal);
	logger.info("DEDUP", `Reduced ${allCodes.length} codes to ${dedup.codes.length} unique codes`);
	const remapped = remapCodesPerReview(codesPerReview, dedup.canonicalOf);
	const n = dedup.codes.length;

	if (n < config.kMin) {
		const file: ClusteredCodesFile = {
			clustering_method: "embedding",
			all_codes: dedup.codes,
			labels: dedup.codes.map(() => 0),
			k: 1,
			cluster_to_codes: { "0": dedup.codes },
			dedup_map: dedup.canonicalOf,
			codes_per_review: remapped,
		};
		return { file, summary: `Axial coding: only ${n} unique codes, placed in 1 cluster.` };
	}

	const m = await embedder.embed(dedup.codes, signal);
	const useMinibatch = n >= config.minibatchThreshold;
	const runKMeans = (k: number): KMeansResult =>
		useMinibatch
			? miniBatchKmeans(m, k, { rng: rng.fork(`mb-${k}`), nInit: 3, batchSize: config.minibatchSize })
			: kmeans(m, k, { rng: rng.fork(`km-${k}`), nInit: config.nInit });

	const selection = selectK(
		m.rows,
		runKMeans,
		new SilhouetteScorer(m, config.silhouetteSampleSize, rng.fork("silhouette")),
		config,
	);
	logger.info(
		"K_SELECTION",
		`best k=${selection.k} silhouette=${selection.silhouette.toFixed(4)} (${useMinibatch ? "mini-batch" : "full"} k-means)`,
	);
	const final = runKMeans(selection.k);

	const grouped = new Map<number, string[]>();
	dedup.codes.forEach((code, i) => {
		const label = final.labels[i]!;
		grouped.set(label, [...(grouped.get(label) ?? []), code]);
	});
	const clusterToCodes = Object.fromEntries(
		[...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([label, codes]) => [String(label), codes]),
	);
	const file: ClusteredCodesFile = {
		clustering_method: "embedding",
		all_codes: dedup.codes,
		labels: Array.from(final.labels),
		k: selection.k,
		cluster_to_codes: clusterToCodes,
		dedup_map: dedup.canonicalOf,
		...(remapped.length > 0 ? { codes_per_review: remapped } : {}),
	};
	return {
		file,
		summary: axialSummary(`Axial coding (embed + K-means): K=${selection.k} clusters.`, clusterToCodes),
	};
}

export function selectK(
	n: number,
	runKMeans: (k: number) => KMeansResult,
	scorer: SilhouetteScorer,
	config: IdcoderConfig["clustering"],
): KSelection {
	const [kLow, kHigh] = kRange(n, config);
	const scores: Record<number, number> = {};
	let best = { k: Math.max(2, kLow), silhouette: -Infinity };
	for (let k = Math.max(2, kLow); k <= kHigh; k++) {
		const score = scorer.score(runKMeans(k).labels);
		scores[k] = score;
		if (score > best.silhouette) best = { k, silhouette: score };
	}
	return { ...best, scores };
}
