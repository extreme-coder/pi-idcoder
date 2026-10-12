import type { RunPaths } from "../artifacts/paths.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import type { Logger } from "../core/logger.ts";
import type { Rng } from "../core/random.ts";
import type { CorpusDocument } from "../corpus/load.ts";
import type { Embedder } from "../embeddings/embedder.ts";
import type { LlmClient } from "../llm/types.ts";
import type { ReviewGateway } from "../review/gateway.ts";

export const STAGE_IDS = [
	"open_coding",
	"source_memory",
	"axial_clustering",
	"cluster_labeling",
	"codebook_review",
	"refine_assignments",
	"codebook_enrichment",
	"hierarchy",
	"meta_themes",
	"dimension_enrichment",
	"tree_assembly",
	"research_report",
	"cooccurrence",
	"viewer_export",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export function isStageId(value: string): value is StageId {
	return (STAGE_IDS as readonly string[]).includes(value);
}

export interface StageProgress {
	done: number;
	total: number;
	message?: string;
}

export interface StageContext {
	readonly config: IdcoderConfig;
	readonly projectDir: string;
	readonly slug: string;
	readonly paths: RunPaths;
	readonly store: ArtifactStore;
	readonly llm: LlmClient;
	readonly embedder: Embedder;
	readonly logger: Logger;
	readonly rng: Rng;
	readonly review: ReviewGateway;
	readonly signal?: AbortSignal | undefined;
	corpus(): Promise<CorpusDocument[]>;
	progress(update: StageProgress): void;
}

export type StageOutcome =
	| { status: "done"; summary: string; metrics?: Record<string, number | string> }
	| { status: "skipped"; summary: string }
	| { status: "paused"; summary: string };

export interface Stage {
	readonly id: StageId;
	readonly title: string;
	/** Disabled stages are recorded as skipped (e.g. enrichment or review turned off). */
	enabled(config: IdcoderConfig): boolean;
	run(ctx: StageContext): Promise<StageOutcome>;
	/** Crash-recovery files: reused when a stage resumes, deleted when it is explicitly re-run. */
	checkpoints?(paths: RunPaths): string[];
}

export function done(summary: string, metrics?: Record<string, number | string>): StageOutcome {
	return metrics ? { status: "done", summary, metrics } : { status: "done", summary };
}
