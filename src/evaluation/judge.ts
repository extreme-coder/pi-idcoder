import type { IdcoderConfig } from "../config/schema.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl, writeJsonl } from "../core/fs.ts";
import { isRecord, parseJsonResponse } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import { Rng } from "../core/random.ts";
import type { LlmClient } from "../llm/types.ts";
import { type JudgeOutcomes, judgeSystemPrompt, judgeUserPrompt } from "../prompts/evaluation.ts";
import { type DisagreementItem, type JudgeRow, preferenceOf, type Verdict } from "./types.ts";

export type JudgeSettings = IdcoderConfig["evaluation"]["judge"];

/** Accepts `A`, `Option B`, `both fit`, `neither`… and rejects anything outside the outcome set. */
export function normalizeVerdict(raw: unknown, outcomes: JudgeOutcomes): Verdict | "" {
	const s = String(raw ?? "")
		.trim()
		.toUpperCase()
		.replace(/[.!]+$/, "");
	const option = /^(?:OPTION\s*)?([AB])$/.exec(s);
	if (option) return option[1] as "A" | "B";
	if (outcomes === "binary") return "";
	if (/^BOTH(\s+FIT)?$/.test(s)) return "BOTH";
	if (/^(NEITHER|NONE)(\s+FITS?)?$/.test(s)) return "NEITHER";
	return "";
}

export interface JudgeBatchRequest {
	llm: LlmClient;
	model: string;
	items: readonly DisagreementItem[];
	outcomes: JudgeOutcomes;
	maxRetries: number;
	logger: Logger;
	signal?: AbortSignal | undefined;
}

/** One batched, blind judging call; accepted when at least 80% of the items got a valid verdict. */
export async function judgeBatch(request: JudgeBatchRequest): Promise<Map<number, Verdict>> {
	const { llm, model, items, outcomes, logger, signal } = request;
	const prompt = judgeUserPrompt(
		items.map((item) => ({ quote: item.quote, optionA: item.option_a, optionB: item.option_b })),
		outcomes,
	);
	for (let attempt = 1; attempt <= request.maxRetries + 1; attempt++) {
		try {
			const response = await llm.complete({
				skill: "disagreement_judge",
				system: judgeSystemPrompt(outcomes),
				prompt,
				model,
				temperature: 0,
				maxTokens: Math.min(8000, Math.max(2000, items.length * 150)),
				labels: { outcomes, attempt },
				signal,
			});
			const parsed = parseJsonResponse(response.text);
			const result = new Map<number, Verdict>();
			for (const verdict of Array.isArray(parsed.verdicts) ? parsed.verdicts : []) {
				if (!isRecord(verdict)) continue;
				const index = verdict.item_index;
				const pick = normalizeVerdict(verdict.pick, outcomes);
				if (typeof index === "number" && Number.isInteger(index) && index >= 1 && index <= items.length && pick) {
					result.set(index, pick);
				}
			}
			if (result.size >= items.length * 0.8) return result;
			logger.warn("JUDGE_PARTIAL", `${model}: ${result.size}/${items.length} valid verdicts (attempt ${attempt})`);
		} catch (error) {
			if (signal?.aborted) throw error;
			logger.warn("JUDGE_FAILED", `${model} attempt ${attempt}: ${(error as Error).message}`);
		}
	}
	return new Map();
}

function toJudgeRow(item: DisagreementItem, model: string, verdict: Verdict | undefined): JudgeRow {
	return verdict
		? {
				item_id: item.item_id,
				judge: model,
				verdict,
				status: "judged",
				preferred: preferenceOf(verdict, item.true_side),
			}
		: { item_id: item.item_id, judge: model, verdict: "", status: "call_failed", preferred: null };
}

/**
 * Paper §3.3 LLM-as-a-judge: every disagreement judged blind by one model, checkpointed per item
 * so an interrupted run never re-bills judged items; failures are retried in reshuffled rounds.
 */
export async function judgeAll(
	items: readonly DisagreementItem[],
	deps: {
		llm: LlmClient;
		model: string;
		settings: JudgeSettings;
		seed: number;
		files: { output: string; checkpoint: string };
		logger: Logger;
		signal?: AbortSignal | undefined;
		onProgress?: (done: number, total: number) => void;
	},
): Promise<{ rows: JudgeRow[]; unresolved: number }> {
	const { settings, files, model } = deps;
	const judged = new Map<string, JudgeRow>();
	const known = new Set(items.map((i) => i.item_id));
	for (const row of await readJsonl<JudgeRow>(files.checkpoint)) {
		if (row.status === "judged" && known.has(row.item_id)) judged.set(row.item_id, row);
	}
	deps.onProgress?.(judged.size, items.length);

	const runRound = async (pending: readonly DisagreementItem[]): Promise<DisagreementItem[]> => {
		const batches: DisagreementItem[][] = [];
		for (let i = 0; i < pending.length; i += settings.batchSize)
			batches.push(pending.slice(i, i + settings.batchSize));
		const failed: DisagreementItem[] = [];
		await mapConcurrent(
			batches,
			settings.workers,
			async (batch) => {
				const verdicts = await judgeBatch({
					llm: deps.llm,
					model,
					items: batch,
					outcomes: settings.outcomes,
					maxRetries: settings.maxRetries,
					logger: deps.logger,
					signal: deps.signal,
				});
				return batch.map((item, i) => ({ item, row: toJudgeRow(item, model, verdicts.get(i + 1)) }));
			},
			{
				signal: deps.signal,
				onResult: async (results) => {
					for (const { item, row } of results) {
						if (row.status === "judged") {
							judged.set(item.item_id, row);
							await appendJsonl(files.checkpoint, row);
						} else {
							failed.push(item);
						}
					}
					deps.onProgress?.(judged.size, items.length);
				},
			},
		);
		return failed;
	};

	let pending = await runRound(items.filter((i) => !judged.has(i.item_id)));
	for (let round = 1; pending.length && round <= settings.maxRounds; round++) {
		deps.logger.warn("JUDGE_ROUND", `${model}: retrying ${pending.length} item(s), round ${round}`);
		pending = await runRound(new Rng(deps.seed + round).shuffle(pending));
	}
	const rows = items.map((item) => judged.get(item.item_id) ?? toJudgeRow(item, model, undefined));
	await writeJsonl(files.output, rows);
	return { rows, unresolved: pending.length };
}
