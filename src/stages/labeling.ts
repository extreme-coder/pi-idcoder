import { createHash } from "node:crypto";
import type { CodebookConfidenceFile, ConfidenceEntry } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl } from "../core/fs.ts";
import { sortClusterIds } from "../core/ids.ts";
import { asClampedInt, asString, parseJsonObject } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import type { Rng } from "../core/random.ts";
import { bulleted } from "../core/text.ts";
import type { LlmClient } from "../llm/types.ts";
import { done, type Stage } from "../pipeline/stage.ts";
import { highLevelCodeGenerationPrompt, highLevelSynthesisPrompt } from "../prompts/pipeline.ts";

export interface LabelResult {
	label: string;
	confidence: number;
	rationale: string;
	candidate_labels?: string[];
}

interface LabelCheckpoint extends LabelResult {
	cluster_id: string;
	codes_hash: string;
}

const MAX_LABEL_CHARS = 80;
const FIRST_N = 30;

function cleanLabel(raw: unknown): string {
	return asString(raw)
		.trim()
		.replace(/^["']+|["']+$/g, "");
}

export function parseLabelResponse(text: string): { label: string; confidence: number; rationale: string } {
	const parsed = parseJsonObject(text);
	return {
		label: cleanLabel(parsed.label),
		confidence: asClampedInt(parsed.confidence, 1, 5, 1),
		rationale: asString(parsed.rationale).trim(),
	};
}

function validLabel(label: string): boolean {
	return label.length > 0 && label.length <= MAX_LABEL_CHARS;
}

export interface LabelDeps {
	llm: LlmClient;
	researchQuestion: string;
	settings: IdcoderConfig["labeling"];
	rng: Rng;
	logger: Logger;
	signal?: AbortSignal | undefined;
}

/** One call over the first 30 codes (the pipeline's default strategy). */
export async function labelFirstN(clusterId: string, codes: readonly string[], deps: LabelDeps): Promise<LabelResult> {
	if (codes.length === 0) return { label: `Cluster ${clusterId}`, confidence: 1, rationale: "" };
	let list = bulleted(codes.slice(0, FIRST_N));
	if (codes.length > FIRST_N) list += `\n- ... and ${codes.length - FIRST_N} more`;
	try {
		const response = await deps.llm.complete({
			skill: "high_level_code_generation",
			prompt: highLevelCodeGenerationPrompt(list, deps.researchQuestion),
			labels: { cluster_id: clusterId },
			signal: deps.signal,
		});
		const parsed = parseLabelResponse(response.text);
		return {
			label: validLabel(parsed.label) ? parsed.label : `Cluster ${clusterId}`,
			confidence: parsed.confidence,
			rationale: parsed.rationale,
		};
	} catch (error) {
		if (deps.signal?.aborted) throw error;
		deps.logger.warn("HIGH_LEVEL_LLM_ERROR", `Cluster ${clusterId}: ${(error as Error).message}`);
		return { label: `Cluster ${clusterId}`, confidence: 1, rationale: "" };
	}
}

/**
 * Paper §3.1: labels for larger clusters are synthesized from several random samples; candidate
 * agreement drives the confidence score and the candidates are kept for later analysis.
 */
export async function labelBySampling(
	clusterId: string,
	codes: readonly string[],
	deps: LabelDeps,
): Promise<LabelResult> {
	const { samples, sampleSize } = deps.settings;
	if (codes.length === 0) return { label: `Cluster ${clusterId}`, confidence: 1, rationale: "", candidate_labels: [] };
	if (codes.length <= sampleSize) return { ...(await labelFirstN(clusterId, codes, deps)), candidate_labels: [] };

	const rng = deps.rng.fork(`label-${clusterId}`);
	const candidates: string[] = [];
	for (let i = 0; i < samples; i++) {
		try {
			const response = await deps.llm.complete({
				skill: "high_level_code_generation",
				prompt: highLevelCodeGenerationPrompt(bulleted(rng.sample(codes, sampleSize)), deps.researchQuestion),
				labels: { cluster_id: clusterId, sample: i },
				signal: deps.signal,
			});
			const { label } = parseLabelResponse(response.text);
			if (validLabel(label)) candidates.push(label);
		} catch (error) {
			if (deps.signal?.aborted) throw error;
			deps.logger.warn("HIGH_LEVEL_LLM_ERROR", `Cluster ${clusterId} sample: ${(error as Error).message}`);
		}
	}
	if (candidates.length === 0)
		return { label: `Cluster ${clusterId}`, confidence: 1, rationale: "", candidate_labels: [] };

	try {
		const response = await deps.llm.complete({
			skill: "high_level_synthesis",
			prompt: highLevelSynthesisPrompt(candidates, deps.researchQuestion),
			labels: { cluster_id: clusterId },
			signal: deps.signal,
		});
		const parsed = parseLabelResponse(response.text);
		return {
			label: validLabel(parsed.label) ? parsed.label : candidates[0]!,
			confidence: parsed.confidence,
			rationale: parsed.rationale,
			candidate_labels: candidates,
		};
	} catch (error) {
		if (deps.signal?.aborted) throw error;
		deps.logger.warn("HIGH_LEVEL_LLM_ERROR", `Cluster ${clusterId} synthesis: ${(error as Error).message}`);
		return { label: candidates[0]!, confidence: 1, rationale: "", candidate_labels: candidates };
	}
}

function codesHash(codes: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify(codes)).digest("hex").slice(0, 16);
}

export const labelingStage: Stage = {
	id: "cluster_labeling",
	title: "Cluster labeling",
	enabled: () => true,
	checkpoints: (paths) => [paths.labelingCheckpoint],
	async run(ctx) {
		const clustered = await ctx.store.clustered();
		const ctc = clustered.cluster_to_codes;
		const ids = sortClusterIds(Object.keys(ctc));
		const codebook: Record<string, string> = {};
		const confidence: CodebookConfidenceFile = {};

		if (clustered.cluster_theme_names && Object.keys(clustered.cluster_theme_names).length > 0) {
			for (const id of ids) {
				const label = (clustered.cluster_theme_names[id] ?? "").trim() || `Cluster ${id}`;
				codebook[id] = label;
				confidence[id] = { label, confidence: 4, rationale: "from LLM axial clustering" };
			}
			await ctx.store.writeCodebook({ codebook, cluster_to_codes: ctc });
			await ctx.store.writeConfidence(confidence);
			ctx.logger.info(
				"HIGH_LEVEL_SKIPPED",
				`Using cluster_theme_names from LLM clustering (${ids.length} clusters).`,
			);
			return done(`${ids.length} labels taken from LLM clustering`, { clusters: ids.length });
		}

		const restored = new Map<string, LabelCheckpoint>();
		for (const row of await readJsonl<LabelCheckpoint>(ctx.paths.labelingCheckpoint))
			restored.set(row.cluster_id, row);
		const deps: LabelDeps = {
			llm: ctx.llm,
			researchQuestion: ctx.config.study.researchQuestion,
			settings: ctx.config.labeling,
			rng: ctx.rng,
			logger: ctx.logger,
			signal: ctx.signal,
		};
		const strategy = ctx.config.labeling.strategy;
		const pending = ids.filter((id) => restored.get(id)?.codes_hash !== codesHash(ctc[id] ?? []));
		ctx.logger.info(
			"HIGH_LEVEL_STRATEGY",
			strategy === "nsampling"
				? `strategy=nsampling n_samples=${deps.settings.samples} sample_size=${deps.settings.sampleSize} workers=${deps.settings.workers}`
				: "strategy=first30",
		);

		let finished = ids.length - pending.length;
		await mapConcurrent(
			pending,
			ctx.config.labeling.workers,
			async (id) => {
				const codes = ctc[id] ?? [];
				const result =
					strategy === "nsampling" ? await labelBySampling(id, codes, deps) : await labelFirstN(id, codes, deps);
				return { ...result, cluster_id: id, codes_hash: codesHash(codes) } satisfies LabelCheckpoint;
			},
			{
				signal: ctx.signal,
				onResult: async (row) => {
					restored.set(row.cluster_id, row);
					await appendJsonl(ctx.paths.labelingCheckpoint, row);
					if (row.confidence <= ctx.config.labeling.lowConfidenceThreshold) {
						ctx.logger.warn(
							"LOW_CONFIDENCE_CLUSTER",
							`Cluster ${row.cluster_id}: confidence=${row.confidence}, label=${row.label}`,
						);
					}
					ctx.progress({ done: ++finished, total: ids.length, message: row.label });
				},
			},
		);

		for (const id of ids) {
			const row = restored.get(id)!;
			codebook[id] = row.label;
			const entry: ConfidenceEntry = { label: row.label, confidence: row.confidence, rationale: row.rationale };
			if (row.candidate_labels !== undefined) entry.candidate_labels = row.candidate_labels;
			confidence[id] = entry;
		}
		await ctx.store.writeCodebook({ codebook, cluster_to_codes: ctc });
		await ctx.store.writeConfidence(confidence);
		const low = Object.values(confidence).filter(
			(c) => c.confidence <= ctx.config.labeling.lowConfidenceThreshold,
		).length;
		return done(`${ids.length} clusters labeled (${low} low-confidence flagged for review)`, {
			clusters: ids.length,
			low_confidence: low,
		});
	},
};
