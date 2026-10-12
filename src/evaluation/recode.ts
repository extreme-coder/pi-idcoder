import { createHash } from "node:crypto";
import type { DetailLevel, IdcoderConfig } from "../config/schema.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl, writeJsonl } from "../core/fs.ts";
import { isRecord, parseJsonResponse } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import { Rng } from "../core/random.ts";
import type { LlmClient } from "../llm/types.ts";
import { recodeSystemPrompt, recodeUserPrompt } from "../prompts/evaluation.ts";
import type { FormattedCodebook } from "./ground-truth.ts";
import type { GroundTruthRow, RecodeRow } from "./types.ts";

export type RecodeSettings = IdcoderConfig["evaluation"]["recode"];

export function rowKey(row: Pick<GroundTruthRow, "review_idx" | "open_code" | "quote">): string {
	return JSON.stringify([row.review_idx, row.open_code, row.quote]);
}

export interface ClassifyRequest {
	llm: LlmClient;
	model: string;
	codebook: FormattedCodebook;
	quotes: readonly string[];
	level: DetailLevel;
	includeReasoning: boolean;
	maxRetries: number;
	logger: Logger;
	signal?: AbortSignal | undefined;
}

/**
 * One batched classification call: returns 1-based quote index → letter or NONE. A response is
 * accepted when at least 80% of the quotes got a valid label; otherwise the call is retried.
 */
export async function classifyBatch(request: ClassifyRequest): Promise<Map<number, string>> {
	const { llm, model, codebook, quotes, level, includeReasoning, logger, signal } = request;
	const valid = new Set([...codebook.letters, "NONE"]);
	const quotesText = quotes.map((q, i) => `${i + 1}. "${q}"`).join("\n");
	const system = recodeSystemPrompt(level, includeReasoning);
	const prompt = recodeUserPrompt(codebook.text, quotesText, level, includeReasoning);
	for (let attempt = 1; attempt <= request.maxRetries + 1; attempt++) {
		try {
			const response = await llm.complete({
				skill: "deductive_recode",
				system,
				prompt,
				model,
				temperature: 0,
				maxTokens: Math.min(16000, Math.max(4000, quotes.length * 250)),
				labels: { level, attempt },
				signal,
			});
			const parsed = parseJsonResponse(response.text);
			const result = new Map<number, string>();
			for (const item of Array.isArray(parsed.classifications) ? parsed.classifications : []) {
				if (!isRecord(item)) continue;
				const index = item.quote_index;
				const letter = String(item.meta_theme ?? "")
					.trim()
					.toUpperCase();
				if (
					typeof index === "number" &&
					Number.isInteger(index) &&
					index >= 1 &&
					index <= quotes.length &&
					valid.has(letter)
				) {
					result.set(index, letter);
				}
			}
			if (result.size >= quotes.length * 0.8) return result;
			logger.warn(
				"RECODE_PARTIAL",
				`${model}: ${result.size}/${quotes.length} valid classifications (attempt ${attempt})`,
			);
		} catch (error) {
			if (signal?.aborted) throw error;
			logger.warn("RECODE_FAILED", `${model} attempt ${attempt}: ${(error as Error).message}`);
		}
	}
	return new Map();
}

/** Turns a raw letter into a row; missing or invalid letters are call failures, never disagreements. */
export function toRecodeRow(
	row: GroundTruthRow,
	letter: string | undefined,
	codebook: FormattedCodebook,
	level: DetailLevel,
	model: string,
): RecodeRow {
	const base = { ...row, detail_level: level, classifier_model: model, pred_letter_raw: letter ?? "" };
	if (letter === "NONE") {
		return { ...base, pred_meta_theme_idx: null, pred_meta_theme_label: "NONE", status: "classified", agree: false };
	}
	const index = letter ? codebook.letters.indexOf(letter) : -1;
	if (index === -1) {
		return { ...base, pred_meta_theme_idx: null, pred_meta_theme_label: "", status: "call_failed", agree: null };
	}
	return {
		...base,
		pred_meta_theme_idx: index,
		pred_meta_theme_label: codebook.labels[index]!,
		status: "classified",
		agree: index === row.true_meta_theme_idx,
	};
}

export interface RecodeOutputs {
	output: string;
	unresolved: string;
	checkpoint: string;
}

export interface RecodeResult {
	rows: RecodeRow[];
	unresolved: RecodeRow[];
	rounds: number;
}

/**
 * Deductive agent (paper §3.2): independently re-assigns every quote to one meta-theme from the
 * codebook alone. Failed quotes are re-batched (reshuffled per round so a deterministic failure
 * meets different neighbours) for up to `maxRounds`; still-failing quotes go to an unresolved file.
 */
export async function recodeAll(
	rows: readonly GroundTruthRow[],
	deps: {
		llm: LlmClient;
		model: string;
		codebook: FormattedCodebook;
		level: DetailLevel;
		settings: RecodeSettings;
		seed: number;
		files: RecodeOutputs;
		logger: Logger;
		signal?: AbortSignal | undefined;
		onProgress?: (done: number, total: number) => void;
	},
): Promise<RecodeResult> {
	const { settings, files } = deps;
	const codebookHash = createHash("sha256").update(deps.codebook.text).digest("hex").slice(0, 16);
	const truth = new Map(rows.map((r) => [rowKey(r), r.true_meta_theme_idx]));
	const good = new Map<string, RecodeRow>();
	for (const row of await readJsonl<RecodeRow>(files.checkpoint)) {
		const current = row.status === "classified" && row.codebook_hash === codebookHash;
		if (current && truth.get(rowKey(row)) === row.true_meta_theme_idx) good.set(rowKey(row), row);
	}
	let pending = rows.filter((r) => !good.has(rowKey(r)));
	const total = rows.length;
	deps.onProgress?.(good.size, total);

	const runRound = async (batchRows: readonly GroundTruthRow[]): Promise<GroundTruthRow[]> => {
		const batches: GroundTruthRow[][] = [];
		for (let i = 0; i < batchRows.length; i += settings.batchSize)
			batches.push(batchRows.slice(i, i + settings.batchSize));
		const failed: GroundTruthRow[] = [];
		await mapConcurrent(
			batches,
			settings.workers,
			async (batch) => {
				const preds = await classifyBatch({
					llm: deps.llm,
					model: deps.model,
					codebook: deps.codebook,
					quotes: batch.map((r) => r.quote),
					level: deps.level,
					includeReasoning: settings.includeReasoning,
					maxRetries: settings.maxRetries,
					logger: deps.logger,
					signal: deps.signal,
				});
				return batch.map((row, i) => ({
					...toRecodeRow(row, preds.get(i + 1), deps.codebook, deps.level, deps.model),
					codebook_hash: codebookHash,
				}));
			},
			{
				signal: deps.signal,
				onResult: async (results) => {
					for (const result of results) {
						if (result.status === "classified") {
							good.set(rowKey(result), result);
							await appendJsonl(files.checkpoint, result);
						} else {
							failed.push(result);
						}
					}
					deps.onProgress?.(good.size, total);
				},
			},
		);
		return failed;
	};

	let rounds = 0;
	pending = await runRound(pending);
	while (pending.length && rounds < settings.maxRounds) {
		rounds++;
		deps.logger.warn(
			"RECODE_ROUND",
			`${deps.model}/${deps.level}: retrying ${pending.length} failed quote(s), round ${rounds}`,
		);
		pending = await runRound(new Rng(deps.seed + rounds).shuffle(pending));
	}

	const ordered = rows.flatMap((r) => {
		const row = good.get(rowKey(r));
		return row ? [row] : [];
	});
	const unresolved = pending.map((r) => toRecodeRow(r, undefined, deps.codebook, deps.level, deps.model));
	await writeJsonl(files.output, ordered);
	await writeJsonl(files.unresolved, unresolved);
	return { rows: ordered, unresolved, rounds };
}
