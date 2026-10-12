import type {
	ClusteredCodesFile,
	ClusterToCodes,
	CodebookConfidenceFile,
	CodebookProvenanceFile,
	ProvenanceEntry,
	ProvenanceSource,
} from "../artifacts/types.ts";
import { sortClusterIds } from "../core/ids.ts";
import type { DropOperation, EnrichedCodebook, MergeOperation, ReviewOperation, SplitOperation } from "./schema.ts";

export class CodebookReviewError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodebookReviewError";
	}
}

export interface AppliedReview {
	codebook: Record<string, string>;
	clusterToCodes: ClusterToCodes;
	confidence: CodebookConfidenceFile;
	provenance: CodebookProvenanceFile;
	orphanedCodes: string[];
	skipRefineClusterIds: Set<string>;
}

function applyMerge(ctc: ClusterToCodes, op: MergeOperation): void {
	const from = (op.from_cluster_ids ?? []).map(String);
	const target = String(op.target_cluster_id ?? "");
	if (from.length === 0 || !target) {
		throw new CodebookReviewError("merge operation requires from_cluster_ids and target_cluster_id");
	}
	let merged: string[] = [];
	for (const cid of from) {
		merged.push(...(ctc[cid] ?? []));
		delete ctc[cid];
	}
	if (ctc[target]) merged = [...ctc[target], ...merged];
	ctc[target] = merged;
}

function applySplit(ctc: ClusterToCodes, op: SplitOperation): void {
	const fromId = String(op.from_cluster_id ?? "");
	const splits = op.splits ?? [];
	if (!fromId || splits.length === 0) {
		throw new CodebookReviewError("split operation requires from_cluster_id and splits");
	}
	const original = [...(ctc[fromId] ?? [])];
	const assigned = new Set<string>();
	for (const part of splits) {
		const newId = String(part.new_cluster_id ?? "");
		if (!newId) throw new CodebookReviewError("split part missing new_cluster_id");
		const codes = (part.code_ids ?? []).map(String);
		for (const code of codes) {
			if (!original.includes(code)) {
				throw new CodebookReviewError(`split code ${JSON.stringify(code)} not in cluster ${fromId}`);
			}
			if (assigned.has(code)) {
				throw new CodebookReviewError(`code ${JSON.stringify(code)} assigned to multiple split groups`);
			}
			assigned.add(code);
		}
		ctc[newId] = codes;
	}
	delete ctc[fromId];
	const unassigned = original.filter((c) => !assigned.has(c));
	if (unassigned.length > 0) {
		throw new CodebookReviewError(
			`split of cluster ${fromId} left codes unassigned: ${JSON.stringify(unassigned.slice(0, 5))}`,
		);
	}
}

function applyDrop(ctc: ClusterToCodes, op: DropOperation, orphaned: string[]): void {
	const cid = String(op.cluster_id ?? "");
	if (!cid) throw new CodebookReviewError("drop operation requires cluster_id");
	const codes = ctc[cid] ?? [];
	delete ctc[cid];
	if ((op.code_disposition ?? "delete") === "orphan") orphaned.push(...codes);
}

/**
 * True when cluster_to_codes already reflects the operation (viewer exports final membership plus
 * a log). An operation counts as applied once its source clusters are gone, even if a later
 * operation has since consumed its outputs (e.g. merge into 0, then split 0).
 */
export function operationAlreadyApplied(ctc: ClusterToCodes, op: ReviewOperation): boolean {
	if (op.type === "split") {
		const from = String(op.from_cluster_id ?? "");
		return Boolean(from) && !(from in ctc);
	}
	if (op.type === "merge") {
		const target = String(op.target_cluster_id ?? "");
		if (!target) return false;
		return !(op.from_cluster_ids ?? []).map(String).some((id) => id && id !== target && id in ctc);
	}
	if (op.type === "drop") {
		const cid = String(op.cluster_id ?? "");
		return Boolean(cid) && !(cid in ctc);
	}
	return false;
}

function validateMembership(ctc: ClusterToCodes): void {
	const seen = new Map<string, string>();
	for (const [cid, codes] of Object.entries(ctc)) {
		for (const code of codes) {
			const other = seen.get(code);
			if (other !== undefined) {
				throw new CodebookReviewError(`code ${JSON.stringify(code)} appears in clusters ${other} and ${cid}`);
			}
			seen.set(code, cid);
		}
	}
}

/** Applies an approved v2 payload: replays outstanding operations, drops clusters, and rekeys ids 0..n-1. */
export function applyCodebookReview(
	v2: EnrichedCodebook,
	clustered: Pick<ClusteredCodesFile, "cluster_to_codes">,
	options: { reviewId?: string | null; approvedAt?: string } = {},
): AppliedReview {
	const fromV2 = Object.entries(v2.cluster_to_codes ?? {});
	const source = fromV2.length > 0 ? fromV2 : Object.entries(clustered.cluster_to_codes ?? {});
	const ctc: ClusterToCodes = Object.fromEntries(source.map(([k, v]) => [String(k), [...v]]));

	const orphaned: string[] = [];
	for (const op of v2.operations ?? []) {
		if (operationAlreadyApplied(ctc, op)) continue;
		switch (op.type) {
			case "merge":
				applyMerge(ctc, op);
				break;
			case "split":
				applySplit(ctc, op);
				break;
			case "drop":
				applyDrop(ctc, op, orphaned);
				break;
			default:
				throw new CodebookReviewError(`unknown operation type: ${JSON.stringify((op as { type?: unknown }).type)}`);
		}
	}

	const clusters = v2.clusters ?? {};
	for (const cid of Object.keys(ctc)) {
		if (clusters[cid]?.status === "drop") {
			orphaned.push(...(ctc[cid] ?? []));
			delete ctc[cid];
		}
	}
	for (const cid of Object.keys(ctc)) if (ctc[cid]!.length === 0) delete ctc[cid];
	validateMembership(ctc);

	const oldIds = sortClusterIds(Object.keys(ctc));
	const approvedAt = options.approvedAt ?? new Date().toISOString();
	const reviewId = options.reviewId ?? null;
	const codebook: Record<string, string> = {};
	const clusterToCodes: ClusterToCodes = {};
	const confidence: CodebookConfidenceFile = {};
	const entries: ProvenanceEntry[] = [];
	const skip = new Set<string>();

	oldIds.forEach((oldId, i) => {
		const newId = String(i);
		const entry = clusters[oldId] ?? {};
		const label = String(entry.label || `Cluster ${newId}`);
		const sourceKind = (entry.source ?? "llm") as ProvenanceSource;
		const needsMore = Boolean(entry.needs_more_evidence);
		clusterToCodes[newId] = ctc[oldId]!;
		codebook[newId] = label;
		confidence[newId] = {
			label,
			confidence: Math.trunc(Number(entry.confidence ?? 1) || 1),
			rationale: String(entry.description ?? ""),
			source: sourceKind,
			needs_more_evidence: needsMore,
		};
		if (needsMore) skip.add(newId);
		entries.push({
			cluster_id: newId,
			source_cluster_id: oldId,
			label,
			source: sourceKind,
			needs_more_evidence: needsMore,
			approved_at: approvedAt,
			review_id: reviewId,
		});
	});

	return {
		codebook,
		clusterToCodes,
		confidence,
		provenance: {
			review_id: reviewId,
			approved_at: approvedAt,
			entries,
			orphaned_codes: orphaned,
			skip_refine_cluster_ids: [...skip].sort(),
		},
		orphanedCodes: orphaned,
		skipRefineClusterIds: skip,
	};
}

/** Rebuilds gt_clustered_codes.json for the reviewed membership (labels index the new clusters). */
export function materializeClustered(result: AppliedReview, clustered: ClusteredCodesFile): ClusteredCodesFile {
	const index = new Map<string, number>();
	Object.values(result.clusterToCodes).forEach((codes, i) => {
		for (const code of codes) index.set(code, i);
	});
	return {
		...(clustered.clustering_method ? { clustering_method: clustered.clustering_method } : {}),
		all_codes: clustered.all_codes ?? [],
		labels: (clustered.all_codes ?? []).map((code) => index.get(code) ?? 0),
		k: Object.keys(result.clusterToCodes).length,
		cluster_to_codes: result.clusterToCodes,
		...(clustered.dedup_map ? { dedup_map: clustered.dedup_map } : {}),
		codes_per_review: clustered.codes_per_review ?? [],
	};
}
