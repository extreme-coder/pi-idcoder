import { type Static, Type } from "typebox";

const Int = (min: number, max: number, def: number, description?: string) =>
	Type.Integer({ minimum: min, maximum: max, default: def, ...(description ? { description } : {}) });

/** `provider/model-id` as listed by pi's model registry, or `current` for the session model. */
export const ModelRefSchema = Type.String({ minLength: 1 });

const detailLevel = (def?: "theme_only" | "theme_def" | "full") =>
	Type.Union(
		[Type.Literal("theme_only"), Type.Literal("theme_def"), Type.Literal("full")],
		def ? { default: def } : {},
	);
export const DetailLevelSchema = detailLevel();
export type DetailLevel = Static<typeof DetailLevelSchema>;

export const StudySchema = Type.Object(
	{
		researchQuestion: Type.String({ minLength: 1, description: "Conditions every LLM step of the pipeline." }),
		data: Type.String({
			minLength: 1,
			description: "CSV, JSONL, or TXT corpus; relative paths resolve from the project.",
		}),
		textColumn: Type.Optional(Type.String({ description: "Defaults to text_review, then review_text, then text." })),
		idColumn: Type.Optional(Type.String({ description: "Defaults to id, then csv_id, then review_id." })),
		slug: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9._-]+$" })),
	},
	{ additionalProperties: false },
);

export const ModelsSchema = Type.Object(
	{
		coder: Type.String({ minLength: 1, default: "current" }),
		validator: Type.Optional(ModelRefSchema),
		clustering: Type.Optional(ModelRefSchema),
		enrichment: Type.Optional(ModelRefSchema),
		report: Type.Optional(ModelRefSchema),
		deductive: Type.Array(ModelRefSchema, { default: [] }),
		judges: Type.Array(ModelRefSchema, { default: [] }),
		temperature: Type.Number({ minimum: 0, maximum: 2, default: 0 }),
		maxTokens: Int(64, 131072, 4096),
		maxRetries: Int(0, 10, 3, "Retries for transient provider failures (rate limits, timeouts, 5xx)."),
		extraBody: Type.Optional(
			Type.Record(Type.String(), Type.Unknown(), {
				description: "Merged into OpenAI-compatible request bodies, e.g. chat_template_kwargs for SGLang.",
			}),
		),
	},
	{ additionalProperties: false, default: {} },
);

export const EmbeddingsSchema = Type.Object(
	{
		provider: Type.Union([Type.Literal("openai-compatible"), Type.Literal("transformers")], {
			default: "openai-compatible",
		}),
		model: Type.String({ minLength: 1, default: "text-embedding-3-small" }),
		baseUrl: Type.String({ default: "https://api.openai.com/v1" }),
		apiKeyEnv: Type.String({ default: "OPENAI_API_KEY" }),
		batchSize: Int(1, 2048, 64),
		dimensions: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Requested output size for models that support it (text-embedding-3-*).",
			}),
		),
		pooling: Type.Union([Type.Literal("mean"), Type.Literal("cls"), Type.Literal("last_token")], {
			default: "mean",
			description: "transformers.js pooling; Qwen3-Embedding expects last_token.",
		}),
		dtype: Type.Optional(Type.String({ description: "transformers.js dtype, e.g. fp32 or q8." })),
	},
	{ additionalProperties: false, default: {} },
);

export const OpenCodingSchema = Type.Object(
	{
		validator: Type.Boolean({ default: false, description: "Generator-validator loop (paper Fig. 1, dashed box)." }),
		maxRetries: Int(0, 10, 2),
		workers: Int(1, 256, 8),
	},
	{ additionalProperties: false, default: {} },
);

export const ClusteringSchema = Type.Object(
	{
		method: Type.Union([Type.Literal("embedding"), Type.Literal("llm")], { default: "embedding" }),
		kMin: Int(2, 100, 5),
		kMaxCap: Int(2, 500, 50),
		kMaxDivisor: Int(1, 100, 3),
		nearDuplicateThreshold: Type.Number({ minimum: 0.5, maximum: 1, default: 0.95 }),
		nInit: Int(1, 50, 10),
		minibatchThreshold: Int(10, 10_000_000, 1000),
		minibatchSize: Int(10, 100_000, 1000),
		silhouetteSampleSize: Int(10, 100_000, 5000),
		llm: Type.Object(
			{
				maxIterations: Int(1, 10, 3),
				batchSize: Int(1, 200, 100),
				saveIterations: Type.Boolean({ default: true }),
				contextLength: Int(2048, 1_048_576, 16384),
				maxCompletion: Int(256, 131072, 8192),
			},
			{ additionalProperties: false, default: {} },
		),
	},
	{ additionalProperties: false, default: {} },
);

export const LabelingSchema = Type.Object(
	{
		strategy: Type.Union([Type.Literal("nsampling"), Type.Literal("first30")], { default: "nsampling" }),
		samples: Int(1, 50, 5),
		sampleSize: Int(2, 500, 15),
		workers: Int(1, 256, 8),
		lowConfidenceThreshold: Int(1, 5, 2),
	},
	{ additionalProperties: false, default: {} },
);

export const ReviewSchema = Type.Object(
	{
		enabled: Type.Boolean({ default: true }),
		mode: Type.Union([Type.Literal("auto"), Type.Literal("tui"), Type.Literal("browser"), Type.Literal("file")], {
			default: "auto",
			description: "auto = terminal review when interactive, otherwise wait for a viewer/file approval.",
		}),
		waitForFile: Type.Boolean({
			default: false,
			description: "In non-interactive runs, block and poll for codebook_v2.json instead of pausing.",
		}),
		timeoutSec: Int(1, 30 * 86400, 86400),
		pollIntervalSec: Int(1, 3600, 30),
	},
	{ additionalProperties: false, default: {} },
);

export const RefineSchema = Type.Object(
	{
		topKOtherClusters: Int(1, 50, 5),
		maxCodesPerCall: Int(16, 80, 44),
	},
	{ additionalProperties: false, default: {} },
);

export const EnrichmentSchema = Type.Object(
	{
		enabled: Type.Boolean({ default: true }),
		workers: Int(1, 256, 4),
		batchThreshold: Int(1, 1000, 25),
		batchSize: Int(1, 500, 20),
		dimensionEvidence: Type.Union([Type.Literal("sampled"), Type.Literal("full")], {
			default: "sampled",
			description: "full = every quote of every cluster plus all neighbouring quotes for exclusion criteria.",
		}),
		quotesPerCluster: Int(1, 100, 3),
	},
	{ additionalProperties: false, default: {} },
);

export const HierarchySchema = Type.Object(
	{
		workers: Int(1, 256, 8),
		firstBatchSize: Int(5, 500, 60),
		assignBatch: Int(20, 60, 40),
		embedDrain: Type.Boolean({ default: false }),
		drainThreshold: Int(0, 10_000, 20),
		refine: Type.Object(
			{
				enabled: Type.Boolean({ default: true }),
				maxCodesPerBucket: Int(4, 80, 48),
				maxDepth: Int(1, 20, 8),
				llmMaxCodes: Int(8, 200, 48),
			},
			{ additionalProperties: false, default: {} },
		),
	},
	{ additionalProperties: false, default: {} },
);

export const ReportSchema = Type.Object(
	{
		contextTokens: Int(1024, 1_048_576, 8000),
		completionTokens: Int(64, 32768, 1024),
	},
	{ additionalProperties: false, default: {} },
);

export const ViewerSchema = Type.Object(
	{
		export: Type.Boolean({ default: true }),
		dataDir: Type.String({ default: ".idcoder/viewer-data" }),
		repo: Type.String({ default: "nimamot/Agentic_Ta_viz" }),
		version: Type.String({ default: "0.2.8" }),
		port: Int(0, 65535, 8765),
		openBrowser: Type.Boolean({ default: true }),
		cacheDir: Type.Optional(Type.String()),
	},
	{ additionalProperties: false, default: {} },
);

export const EvaluationSchema = Type.Object(
	{
		levels: Type.Array(DetailLevelSchema, { default: ["theme_only", "theme_def", "full"], minItems: 1 }),
		recode: Type.Object(
			{
				batchSize: Int(1, 200, 25),
				workers: Int(1, 256, 8),
				maxRounds: Int(0, 50, 8),
				maxRetries: Int(0, 10, 2),
				includeReasoning: Type.Boolean({ default: false }),
			},
			{ additionalProperties: false, default: {} },
		),
		judge: Type.Object(
			{
				outcomes: Type.Union([Type.Literal("four_way"), Type.Literal("binary")], {
					default: "four_way",
					description: "four_way = prefer A / prefer B / both fit / neither fits (paper §3.3).",
				}),
				level: detailLevel("full"),
				batchSize: Int(1, 100, 10),
				workers: Int(1, 256, 8),
				maxRounds: Int(0, 50, 8),
				maxRetries: Int(0, 10, 2),
			},
			{ additionalProperties: false, default: {} },
		),
		human: Type.Object(
			{
				itemsPerAnnotator: Int(1, 100_000, 50),
			},
			{ additionalProperties: false, default: {} },
		),
	},
	{ additionalProperties: false, default: {} },
);

export const IdcoderConfigSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		study: StudySchema,
		seed: Type.Integer({ default: 20260726 }),
		models: ModelsSchema,
		embeddings: EmbeddingsSchema,
		openCoding: OpenCodingSchema,
		clustering: ClusteringSchema,
		labeling: LabelingSchema,
		review: ReviewSchema,
		refine: RefineSchema,
		enrichment: EnrichmentSchema,
		hierarchy: HierarchySchema,
		report: ReportSchema,
		viewer: ViewerSchema,
		evaluation: EvaluationSchema,
		skills: Type.Object(
			{
				enabled: Type.Boolean({ default: true }),
				dir: Type.Optional(Type.String({ description: "Overrides the bundled pipeline system prompts." })),
			},
			{ additionalProperties: false, default: {} },
		),
	},
	{ additionalProperties: false },
);

export type IdcoderConfig = Static<typeof IdcoderConfigSchema>;
export type ModelsConfig = Static<typeof ModelsSchema>;
export type EmbeddingsConfig = Static<typeof EmbeddingsSchema>;
