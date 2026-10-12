import type { ClusterToCodes, CodebookConfidenceFile, HierarchyFile } from "../artifacts/types.ts";
import { sortClusterIds } from "../core/ids.ts";
import { removeThinkTags } from "../core/json.ts";
import { bulleted } from "../core/text.ts";
import { similaritiesTo } from "../embeddings/vector.ts";
import { done, type Stage } from "../pipeline/stage.ts";
import { refineClusterAssignmentsPrompt } from "../prompts/pipeline.ts";

export interface Move {
	code: string;
	from: string;
	to: string;
}

const MOVE_LINE = /MOVE:\s*["']([^"']+)["']\s*(?:→|->|>)\s*["']([^"']+)["']/i;

export function parseMoveLine(line: string): { code: string; target: string } | undefined {
	const match = MOVE_LINE.exec(line.trim());
	return match ? { code: match[1]!.trim(), target: match[2]!.trim() } : undefined;
}

/** Keeps the first move per code; later conflicting suggestions are dropped. */
export function dedupeMoves(moves: readonly Move[], onConflict?: (code: string) => void): Move[] {
	const seen = new Set<string>();
	const out: Move[] = [];
	for (const move of moves) {
		if (seen.has(move.code)) {
			onConflict?.(move.code);
			continue;
		}
		seen.add(move.code);
		out.push(move);
	}
	return out;
}

/**
 * Applies moves and rekeys surviving clusters to 0..n-1 in numeric order. Returns the new
 * membership and the old id behind each new id.
 */
export function applyMoves(
	clusterToCodes: ClusterToCodes,
	moves: readonly Move[],
): { clusterToCodes: ClusterToCodes; oldIds: string[] } {
	const destination = new Map<string, string>();
	for (const [cid, codes] of Object.entries(clusterToCodes)) for (const code of codes) destination.set(code, cid);
	for (const move of moves) if (destination.has(move.code)) destination.set(move.code, move.to);
	const grouped = new Map<string, string[]>();
	for (const [code, cid] of destination) grouped.set(cid, [...(grouped.get(cid) ?? []), code]);
	const oldIds = sortClusterIds([...grouped.keys()].filter((cid) => grouped.get(cid)!.length > 0));
	return {
		clusterToCodes: Object.fromEntries(oldIds.map((oldId, i) => [String(i), grouped.get(oldId)!])),
		oldIds,
	};
}

export function pruneHierarchy(
	hierarchy: HierarchyFile,
	validIds: ReadonlySet<string>,
): { pruned: HierarchyFile; removed: string[] } {
	const removed = Object.keys(hierarchy).filter((k) => !validIds.has(k));
	const pruned = Object.fromEntries(Object.entries(hierarchy).filter(([k]) => validIds.has(k)));
	return { pruned, removed };
}

export const refineStage: Stage = {
	id: "refine_assignments",
	title: "Refine cluster assignments",
	enabled: () => true,
	async run(ctx) {
		const codebook = (await ctx.store.codebook()).codebook;
		const clustered = await ctx.store.clustered();
		const ctc = clustered.cluster_to_codes;
		const ids = sortClusterIds(Object.keys(ctc));
		if (ids.length === 0) throw new Error("No clusters to refine.");

		const labelOf = (cid: string) => codebook[cid] ?? `Cluster ${cid}`;
		const idsByLabel = new Map<string, string[]>();
		for (const [cid, label] of Object.entries(codebook))
			idsByLabel.set(label, [...(idsByLabel.get(label) ?? []), cid]);
		const embeddings = await ctx.embedder.embed(ids.map(labelOf), ctx.signal);

		const provenance = await ctx.store.provenance();
		const confidence = await ctx.store.confidence();
		const skip = new Set(provenance?.skip_refine_cluster_ids ?? []);
		if (skip.size === 0) {
			for (const [cid, entry] of Object.entries(confidence)) if (entry.needs_more_evidence) skip.add(cid);
		}

		const proposed: Move[] = [];
		const k = Math.min(ctx.config.refine.topKOtherClusters, ids.length - 1);
		const maxChunk = ctx.config.refine.maxCodesPerCall;
		for (const [position, cid] of ids.entries()) {
			if (skip.has(cid)) {
				ctx.logger.info("REFINE_SKIP_HUMAN_FLAG", `Cluster ${cid}: needs_more_evidence or human skip`);
				continue;
			}
			const codes = ctc[cid] ?? [];
			if (codes.length === 0) continue;
			const sims = similaritiesTo(embeddings, position);
			const others = ids
				.map((_, j) => j)
				.filter((j) => j !== position)
				.sort((a, b) => sims[b]! - sims[a]!)
				.slice(0, Math.max(0, k))
				.map((j) => labelOf(ids[j]!));
			const otherText = others.length ? others.join(", ") : "(none)";

			for (let start = 0, chunk = 0; start < codes.length; start += maxChunk, chunk++) {
				const slice = codes.slice(start, start + maxChunk);
				const allowed = new Set(slice);
				let text: string;
				try {
					const response = await ctx.llm.complete({
						skill: "refine_cluster_assignments",
						prompt: refineClusterAssignmentsPrompt(labelOf(cid), bulleted(slice), otherText),
						labels: { cluster_id: cid, chunk_index: chunk },
						signal: ctx.signal,
					});
					text = removeThinkTags(response.text);
				} catch (error) {
					if (ctx.signal?.aborted) throw error;
					ctx.logger.warn("REFINE_LLM_ERROR", `Cluster ${cid} chunk ${chunk}: ${(error as Error).message}`);
					continue;
				}
				for (const line of text.split("\n")) {
					if (!line.trim() || line.trim().toUpperCase() === "NONE") continue;
					const parsed = parseMoveLine(line);
					if (!parsed || !allowed.has(parsed.code)) continue;
					const targets = idsByLabel.get(parsed.target) ?? [];
					if (targets.length === 0) continue;
					if (targets.length > 1) {
						ctx.logger.info(
							"REFINE_SKIP_AMBIGUOUS_LABEL",
							`MOVE skipped: label '${parsed.target}' maps to multiple clusters`,
						);
						continue;
					}
					if (targets[0] !== cid) proposed.push({ code: parsed.code, from: cid, to: targets[0]! });
				}
			}
			ctx.progress({ done: position + 1, total: ids.length });
		}

		const moves = dedupeMoves(proposed, (code) =>
			ctx.logger.info("REFINE_CONFLICTING_MOVE", `Code '${code}' has multiple move targets; keeping first.`),
		);
		const { clusterToCodes, oldIds } = applyMoves(ctc, moves);
		const index = new Map<string, number>();
		Object.values(clusterToCodes).forEach((codes, i) => {
			for (const code of codes) index.set(code, i);
		});
		// LLM-clustering theme names are keyed by the old cluster ids, so they cannot survive the rekey
		const { cluster_theme_names: _staleNames, ...rest } = clustered;
		await ctx.store.writeClustered({
			...rest,
			labels: clustered.all_codes.map((code) => index.get(code) ?? 0),
			k: oldIds.length,
			cluster_to_codes: clusterToCodes,
		});

		const newCodebook = Object.fromEntries(oldIds.map((oldId, i) => [String(i), labelOf(oldId)]));
		await ctx.store.writeCodebook({ codebook: newCodebook, cluster_to_codes: clusterToCodes });
		const rekeyed: CodebookConfidenceFile = Object.fromEntries(
			oldIds.map((oldId, i) => {
				const label = newCodebook[String(i)]!;
				const old = confidence[oldId];
				return [String(i), old ? { ...old, label } : { label, confidence: 1, rationale: "" }];
			}),
		);
		await ctx.store.writeConfidence(rekeyed);

		const hierarchy = await ctx.store.hierarchyIfExists();
		if (hierarchy) {
			const { pruned, removed } = pruneHierarchy(hierarchy, new Set(Object.keys(clusterToCodes)));
			if (removed.length) {
				await ctx.store.writeHierarchy(pruned);
				ctx.logger.info(
					"HIERARCHY_PRUNE_AFTER_REFINE",
					`Removed ${removed.length} stale cluster key(s) after rekey`,
				);
			}
		}
		return done(`Refined cluster assignments: ${moves.length} codes moved across clusters.`, {
			moves: moves.length,
			clusters: oldIds.length,
		});
	},
};
