import { join } from "node:path";

export const RUNS_DIR = join(".idcoder", "runs");

/** File layout of one run; data file names are kept identical to the original pipeline outputs. */
export class RunPaths {
	readonly root: string;
	readonly data: string;
	readonly logs: string;
	readonly evaluation: string;

	constructor(root: string) {
		this.root = root;
		this.data = join(root, "data");
		this.logs = join(root, "logs");
		this.evaluation = join(root, "evaluation");
	}

	static forSlug(projectDir: string, slug: string): RunPaths {
		return new RunPaths(join(projectDir, RUNS_DIR, slug));
	}

	get state(): string {
		return join(this.root, "state.json");
	}
	get configSnapshot(): string {
		return join(this.root, "config.snapshot.json");
	}
	get openCodingCheckpoint(): string {
		return join(this.data, "open_coding.checkpoint.jsonl");
	}
	get labelingCheckpoint(): string {
		return join(this.data, "labeling.checkpoint.jsonl");
	}
	get enrichmentCheckpoint(): string {
		return join(this.data, "enrichment.checkpoint.jsonl");
	}
	get hierarchyCheckpoint(): string {
		return join(this.data, "hierarchy.checkpoint.jsonl");
	}
	get dimensionsCheckpoint(): string {
		return join(this.data, "dimensions.checkpoint.jsonl");
	}
	get openCodesMarkdown(): string {
		return join(this.data, "gt_open_codes_all_reviews.md");
	}
	get codesOnly(): string {
		return join(this.data, "gt_codes_only.json");
	}
	get sourceMemory(): string {
		return join(this.data, "gt_source_memory.json");
	}
	get clusteredCodes(): string {
		return join(this.data, "gt_clustered_codes.json");
	}
	get llmClusteringDir(): string {
		return join(this.data, "llm_clustering");
	}
	get codebook(): string {
		return join(this.data, "codebook.json");
	}
	get codebookConfidence(): string {
		return join(this.data, "codebook_confidence.json");
	}
	get codebookProvenance(): string {
		return join(this.data, "codebook_provenance.json");
	}
	get codebookV1(): string {
		return join(this.data, "codebook_v1.json");
	}
	get codebookV2(): string {
		return join(this.data, "codebook_v2.json");
	}
	get codeIdMap(): string {
		return join(this.data, "gt_code_id_map.json");
	}
	get hierarchy(): string {
		return join(this.data, "gt_hierarchy.json");
	}
	get metaThemes(): string {
		return join(this.data, "gt_meta_themes.json");
	}
	get metaThemesEnriched(): string {
		return join(this.data, "gt_meta_themes_enriched.json");
	}
	get metaThemesEnrichedFull(): string {
		return join(this.data, "gt_meta_themes_enriched_full.json");
	}
	get globalGraph(): string {
		return join(this.data, "gt_global_graph.json");
	}
	get researchReport(): string {
		return join(this.data, "research_report.md");
	}
	get cooccurrence(): string {
		return join(this.data, "gt_cooccurrence.json");
	}
	get trace(): string {
		return join(this.logs, "gt_agent_trace.log");
	}
	get usage(): string {
		return join(this.logs, "gt_llm_usage.jsonl");
	}
}
