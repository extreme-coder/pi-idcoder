/**
 * On-disk artifact shapes. Field names stay snake_case and match the original pipeline so the
 * Graph Builder viewer and existing analysis scripts read them unchanged.
 */

/** `[review_id, codes]`, review ids are 1-based corpus positions. */
export type ReviewCodes = [number, string[]];

export interface CodesOnlyFile {
	all_codes: string[];
	codes_per_review: ReviewCodes[];
}

export type ClusterToCodes = Record<string, string[]>;

export interface ClusteredCodesFile {
	clustering_method?: "embedding" | "llm";
	all_codes: string[];
	labels: number[];
	k: number;
	cluster_to_codes: ClusterToCodes;
	dedup_map?: Record<string, string>;
	codes_per_review?: ReviewCodes[];
	cluster_theme_names?: Record<string, string>;
}

export interface GroundedExample {
	snippet_id: string;
	review_id: number;
	source_id: string | null;
	open_code_id: string | null;
	open_code: string;
	quote: string;
}

export interface Criterion {
	criterion: string;
	code_ids: string[];
	examples?: Array<GroundedExample | string>;
}

export interface EnrichedEntry {
	label: string;
	definition: string;
	keywords: string[];
	inclusion: Criterion[];
	exclusion: Criterion[];
	cluster_ids?: string[];
}

export interface CodebookFile {
	codebook: Record<string, string>;
	cluster_to_codes: ClusterToCodes;
	codebook_enriched?: Record<string, EnrichedEntry>;
	enriched_schema_version?: number;
}

export type ProvenanceSource = "llm" | "human" | "llm+edited";

export interface ConfidenceEntry {
	label: string;
	confidence: number;
	rationale: string;
	candidate_labels?: string[];
	source?: ProvenanceSource;
	needs_more_evidence?: boolean;
}

export type CodebookConfidenceFile = Record<string, ConfidenceEntry>;

export interface ProvenanceEntry {
	cluster_id: string;
	source_cluster_id: string;
	label: string;
	source: ProvenanceSource;
	needs_more_evidence: boolean;
	approved_at: string;
	review_id: string | null;
}

export interface CodebookProvenanceFile {
	review_id: string | null;
	approved_at: string;
	entries: ProvenanceEntry[];
	orphaned_codes: string[];
	skip_refine_cluster_ids: string[];
}

export interface SubTheme {
	name: string;
	codes?: string[];
	sub_themes?: SubTheme[];
}

export interface HierarchyEntry {
	label: string;
	sub_themes: SubTheme[];
	ungrouped_codes: string[];
}

export type HierarchyFile = Record<string, HierarchyEntry>;

export interface MetaTheme {
	name: string;
	cluster_ids: string[];
}

export interface MetaThemesFile {
	meta_themes: MetaTheme[];
}

export interface DimensionsEnrichedFile {
	meta_themes_enriched: EnrichedEntry[];
	enriched_schema_version: number;
}

export type TreeNodeType = "root" | "meta_theme" | "theme" | "sub_theme" | "code";

export interface TreeNode {
	name: string;
	type: TreeNodeType;
	children?: TreeNode[];
}

export interface Edge {
	parent: string;
	child: string;
}

export interface GlobalGraphFile {
	tree: TreeNode;
	canonical_nodes: string[];
	merge_groups: unknown[];
	edges: Edge[];
	inferred_edges: unknown[];
}

export const ENRICHED_SCHEMA_VERSION = 1;
