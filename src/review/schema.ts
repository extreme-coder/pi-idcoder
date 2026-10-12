import type { ClusterToCodes, CodebookConfidenceFile, ProvenanceSource } from "../artifacts/types.ts";

/**
 * Codebook review payloads: v1 is what the pipeline proposes, v2 is what the researcher approves.
 * Compatible with the Graph Builder viewer's codebook review export.
 */

export type ClusterStatus = "keep" | "drop";

export interface ClusterEntry {
	label: string;
	description: string;
	confidence: number;
	source: ProvenanceSource;
	needs_more_evidence: boolean;
	status: ClusterStatus;
}

export interface MergeOperation {
	type: "merge";
	from_cluster_ids: string[];
	target_cluster_id: string;
	label?: string;
}

export interface SplitPart {
	new_cluster_id: string;
	label?: string;
	code_ids: string[];
}

export interface SplitOperation {
	type: "split";
	from_cluster_id: string;
	splits: SplitPart[];
}

export interface DropOperation {
	type: "drop";
	cluster_id: string;
	code_disposition: "delete" | "orphan";
}

export type ReviewOperation = MergeOperation | SplitOperation | DropOperation;

export interface EnrichedCodebook {
	version: number;
	clusters: Record<string, Partial<ClusterEntry>>;
	operations: ReviewOperation[];
	cluster_to_codes: ClusterToCodes;
}

export function defaultClusterEntry(
	label: string,
	options: { description?: string; confidence?: number; source?: ProvenanceSource } = {},
): ClusterEntry {
	return {
		label,
		description: options.description ?? "",
		confidence: options.confidence ?? 1,
		source: options.source ?? "llm",
		needs_more_evidence: false,
		status: "keep",
	};
}

/** Builds the v1 review payload from the pipeline's flat codebook artifacts. */
export function buildV1(
	codebook: Record<string, string>,
	clusterToCodes: ClusterToCodes,
	confidence: CodebookConfidenceFile = {},
): EnrichedCodebook {
	const clusters: Record<string, ClusterEntry> = {};
	for (const [cid, label] of Object.entries(codebook)) {
		const conf = confidence[cid];
		clusters[cid] = defaultClusterEntry(label, {
			description: conf?.rationale ?? "",
			confidence: Number(conf?.confidence ?? 1) || 1,
			source: "llm",
		});
	}
	return {
		version: 1,
		clusters,
		operations: [],
		cluster_to_codes: Object.fromEntries(Object.entries(clusterToCodes).map(([k, v]) => [k, [...v]])),
	};
}

export function flatCodebook(enriched: EnrichedCodebook): Record<string, string> {
	return Object.fromEntries(
		Object.entries(enriched.clusters).map(([cid, entry]) => [cid, entry.label || `Cluster ${cid}`]),
	);
}
