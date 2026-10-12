import type { EmbeddingsConfig } from "../config/schema.ts";
import { AbortedError, sleep } from "../core/concurrency.ts";
import { isRecord } from "../core/json.ts";
import { isTransientMessage } from "../llm/types.ts";
import { Matrix, normalizeRows } from "./vector.ts";

export interface Embedder {
	/** Returns one L2-normalized row per input text, in input order. */
	embed(texts: readonly string[], signal?: AbortSignal): Promise<Matrix>;
}

export class EmbeddingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EmbeddingError";
	}
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Any `/v1/embeddings` server: OpenAI, OpenRouter, LM Studio, vLLM, SGLang, Ollama. */
export class OpenAICompatibleEmbedder implements Embedder {
	private readonly config: EmbeddingsConfig;
	private readonly fetchImpl: FetchLike;
	private readonly env: NodeJS.ProcessEnv;
	private readonly maxRetries: number;
	private readonly retryBaseMs: number;

	constructor(
		config: EmbeddingsConfig,
		options: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; maxRetries?: number; retryBaseMs?: number } = {},
	) {
		this.config = config;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.env = options.env ?? process.env;
		this.maxRetries = options.maxRetries ?? 3;
		this.retryBaseMs = options.retryBaseMs ?? 1000;
	}

	async embed(texts: readonly string[], signal?: AbortSignal): Promise<Matrix> {
		const rows: number[][] = [];
		for (let start = 0; start < texts.length; start += this.config.batchSize) {
			rows.push(...(await this.embedBatch(texts.slice(start, start + this.config.batchSize), signal)));
		}
		if (rows.length === 0) return new Matrix(0, 0);
		return normalizeRows(Matrix.fromRows(rows));
	}

	private async embedBatch(batch: readonly string[], signal?: AbortSignal): Promise<number[][]> {
		const url = `${this.config.baseUrl.replace(/\/+$/, "")}/embeddings`;
		const apiKey = this.config.apiKeyEnv ? this.env[this.config.apiKeyEnv] : undefined;
		const body = JSON.stringify({
			model: this.config.model,
			input: batch,
			...(this.config.dimensions ? { dimensions: this.config.dimensions } : {}),
		});
		for (let attempt = 1; ; attempt++) {
			if (signal?.aborted) throw new AbortedError();
			let message: string;
			try {
				const response = await this.fetchImpl(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
					},
					body,
					...(signal ? { signal } : {}),
				});
				if (response.ok) return parseEmbeddingResponse(await response.json(), batch.length);
				message = `HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`;
			} catch (error) {
				if (signal?.aborted) throw new AbortedError();
				if (error instanceof EmbeddingError) throw error;
				message = error instanceof Error ? error.message : String(error);
			}
			if (attempt > this.maxRetries || !isTransientMessage(message)) {
				throw new EmbeddingError(`Embedding request to ${url} failed: ${message}`);
			}
			await sleep(Math.min(30_000, this.retryBaseMs * 2 ** (attempt - 1)), signal);
		}
	}
}

export function parseEmbeddingResponse(payload: unknown, expected: number): number[][] {
	if (!isRecord(payload) || !Array.isArray(payload.data)) {
		throw new EmbeddingError("Embedding response has no data array");
	}
	const items = payload.data
		.filter(isRecord)
		.map((item, position) => ({
			index: typeof item.index === "number" ? item.index : position,
			embedding: item.embedding,
		}))
		.sort((a, b) => a.index - b.index);
	if (items.length !== expected) {
		throw new EmbeddingError(`Embedding response has ${items.length} vectors, expected ${expected}`);
	}
	return items.map(({ embedding }, i) => {
		if (!Array.isArray(embedding) || embedding.some((x) => typeof x !== "number")) {
			throw new EmbeddingError(`Embedding ${i} is not a numeric array (base64 encoding is not supported)`);
		}
		return embedding as number[];
	});
}

export type FeatureExtractor = (
	texts: string[],
	options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export interface TransformersModule {
	pipeline(task: string, model: string, options: object): Promise<FeatureExtractor>;
}

const loadTransformers = (): Promise<TransformersModule> => {
	const moduleName = "@huggingface/transformers";
	return import(moduleName);
};

/** Local embeddings through transformers.js (optional dependency), e.g. onnx-community/Qwen3-Embedding-0.6B-ONNX. */
export class TransformersEmbedder implements Embedder {
	private readonly config: EmbeddingsConfig;
	private readonly loader: () => Promise<TransformersModule>;
	private extractor: Promise<FeatureExtractor> | undefined;

	constructor(config: EmbeddingsConfig, loader: () => Promise<TransformersModule> = loadTransformers) {
		this.config = config;
		this.loader = loader;
	}

	private load(): Promise<FeatureExtractor> {
		this.extractor ??= (async () => {
			let mod: TransformersModule;
			try {
				mod = await this.loader();
			} catch {
				throw new EmbeddingError(
					'Local embeddings need the optional dependency "@huggingface/transformers"; install it next to pi-idcoder or use provider "openai-compatible".',
				);
			}
			return mod.pipeline(
				"feature-extraction",
				this.config.model,
				this.config.dtype ? { dtype: this.config.dtype } : {},
			);
		})();
		return this.extractor;
	}

	async embed(texts: readonly string[], signal?: AbortSignal): Promise<Matrix> {
		const extractor = await this.load();
		const rows: number[][] = [];
		for (let start = 0; start < texts.length; start += this.config.batchSize) {
			if (signal?.aborted) throw new AbortedError();
			const output = await extractor([...texts.slice(start, start + this.config.batchSize)], {
				pooling: this.config.pooling,
				normalize: true,
			});
			rows.push(...output.tolist());
		}
		if (rows.length === 0) return new Matrix(0, 0);
		return normalizeRows(Matrix.fromRows(rows));
	}
}

/** Memoizes vectors by text: dedup, refinement, and hierarchy draining re-embed overlapping strings. */
export class CachingEmbedder implements Embedder {
	private readonly inner: Embedder;
	private readonly cache = new Map<string, Float32Array>();

	constructor(inner: Embedder) {
		this.inner = inner;
	}

	async embed(texts: readonly string[], signal?: AbortSignal): Promise<Matrix> {
		const missing = [...new Set(texts.filter((t) => !this.cache.has(t)))];
		if (missing.length > 0) {
			const fresh = await this.inner.embed(missing, signal);
			missing.forEach((text, i) => {
				this.cache.set(text, Float32Array.from(fresh.row(i)));
			});
		}
		if (texts.length === 0) return new Matrix(0, 0);
		return Matrix.fromRows(texts.map((t) => this.cache.get(t)!));
	}
}

export function createEmbedder(config: EmbeddingsConfig): Embedder {
	const inner =
		config.provider === "transformers" ? new TransformersEmbedder(config) : new OpenAICompatibleEmbedder(config);
	return new CachingEmbedder(inner);
}
