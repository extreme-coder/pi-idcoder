import { RunPaths } from "../artifacts/paths.ts";
import { ArtifactStore } from "../artifacts/store.ts";
import { resolveDataPath, resolveSlug } from "../config/load.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { writeJson } from "../core/fs.ts";
import { TraceLogger } from "../core/logger.ts";
import { Rng } from "../core/random.ts";
import { type CorpusDocument, loadCorpus } from "../corpus/load.ts";
import { createEmbedder, type Embedder } from "../embeddings/embedder.ts";
import type { ModelGateway } from "../llm/gateway.ts";
import { LlmService, modelRefForRole } from "../llm/service.ts";
import { SkillLibrary } from "../llm/skills.ts";
import { UsageRecorder } from "../llm/usage.ts";
import type { ReviewGateway } from "../review/gateway.ts";
import { axialStage } from "../stages/axial.ts";
import { codebookEnrichmentStage } from "../stages/codebook-enrichment.ts";
import { dimensionEnrichmentStage } from "../stages/dimension-enrichment.ts";
import { cooccurrenceStage, researchReportStage, treeAssemblyStage, viewerExportStage } from "../stages/finalize.ts";
import { hierarchyStage } from "../stages/hierarchy.ts";
import { labelingStage } from "../stages/labeling.ts";
import { metaThemesStage } from "../stages/meta-themes.ts";
import { openCodingStage } from "../stages/open-coding.ts";
import { refineStage } from "../stages/refine.ts";
import { reviewGateStage } from "../stages/review-gate.ts";
import { sourceMemoryStage } from "../stages/source-memory.ts";
import { PipelineRunner, type RunEvent, type RunResult } from "./runner.ts";
import type { Stage, StageId } from "./stage.ts";
import { configHash, freshState, loadState, type RunState } from "./state.ts";

/** The inductive coding agent of paper Fig. 1, in execution order. */
export const INDUCTIVE_STAGES: readonly Stage[] = [
	openCodingStage,
	sourceMemoryStage,
	axialStage,
	labelingStage,
	reviewGateStage,
	refineStage,
	codebookEnrichmentStage,
	hierarchyStage,
	metaThemesStage,
	dimensionEnrichmentStage,
	treeAssemblyStage,
	researchReportStage,
	cooccurrenceStage,
	viewerExportStage,
];

export interface RunSessionOptions {
	projectDir: string;
	config: IdcoderConfig;
	gateway: ModelGateway;
	embedder?: Embedder;
	stages?: readonly Stage[];
	retryBaseMs?: number;
}

export interface RunRequest {
	review: ReviewGateway;
	from?: StageId | undefined;
	until?: StageId | undefined;
	signal?: AbortSignal | undefined;
	onEvent?: ((event: RunEvent) => void) | undefined;
}

/** Everything one run needs: paths, artifacts, logging, usage accounting, models, and embeddings. */
export class RunSession {
	readonly projectDir: string;
	readonly config: IdcoderConfig;
	readonly slug: string;
	readonly paths: RunPaths;
	readonly store: ArtifactStore;
	readonly logger: TraceLogger;
	readonly usage: UsageRecorder;
	readonly llm: LlmService;
	readonly embedder: Embedder;
	private readonly stages: readonly Stage[];
	private corpusCache: Promise<CorpusDocument[]> | undefined;

	constructor(options: RunSessionOptions) {
		this.projectDir = options.projectDir;
		this.config = options.config;
		this.slug = resolveSlug(options.config);
		this.paths = RunPaths.forSlug(options.projectDir, this.slug);
		this.store = new ArtifactStore(this.paths);
		this.logger = new TraceLogger(this.paths.trace);
		this.usage = new UsageRecorder(this.paths.usage);
		this.llm = new LlmService({
			gateway: options.gateway,
			models: options.config.models,
			skills: new SkillLibrary({ enabled: options.config.skills.enabled, overrideDir: options.config.skills.dir }),
			usage: this.usage,
			logger: this.logger,
			...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
		});
		this.embedder = options.embedder ?? createEmbedder(options.config.embeddings);
		this.stages = options.stages ?? INDUCTIVE_STAGES;
	}

	corpus(): Promise<CorpusDocument[]> {
		this.corpusCache ??= loadCorpus(resolveDataPath(this.config, this.projectDir), {
			textColumn: this.config.study.textColumn,
			idColumn: this.config.study.idColumn,
		});
		return this.corpusCache;
	}

	/** Model references the inductive pipeline will call with the current config. */
	inductiveModelRefs(): string[] {
		const { config } = this;
		const refs = [modelRefForRole(config.models, "coder"), modelRefForRole(config.models, "report")];
		if (config.openCoding.validator) refs.push(modelRefForRole(config.models, "validator"));
		if (config.clustering.method === "llm") refs.push(modelRefForRole(config.models, "clustering"));
		if (config.enrichment.enabled) refs.push(modelRefForRole(config.models, "enrichment"));
		return refs;
	}

	async state(): Promise<RunState> {
		return (await loadState(this.paths.state)) ?? freshState(this.slug, this.config);
	}

	async run(request: RunRequest): Promise<RunResult> {
		this.llm.validateModels(this.inductiveModelRefs());
		const state = await this.state();
		const hash = configHash(this.config);
		if (state.configHash !== hash) {
			this.logger.warn(
				"CONFIG_CHANGED",
				"Config differs from the one this run started with; completed stages are kept. Use `from` to recompute.",
			);
			state.configHash = hash;
		}
		await writeJson(this.paths.configSnapshot, this.config);
		const runner = new PipelineRunner(this.stages);
		const rng = new Rng(this.config.seed);
		try {
			return await runner.run(
				state,
				this.paths,
				(stage, progress) => ({
					config: this.config,
					projectDir: this.projectDir,
					slug: this.slug,
					paths: this.paths,
					store: this.store,
					llm: this.llm.forStage(stage.id),
					embedder: this.embedder,
					logger: this.logger,
					rng: rng.fork(stage.id),
					review: request.review,
					signal: request.signal,
					corpus: () => this.corpus(),
					progress,
				}),
				{
					from: request.from,
					until: request.until,
					onEvent: request.onEvent,
					signal: request.signal,
					config: this.config,
				},
			);
		} finally {
			await this.logger.flush();
			await this.usage.flush();
		}
	}
}
