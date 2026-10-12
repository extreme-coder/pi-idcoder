import type { DetailLevel } from "../config/schema.ts";
import { fileExists, readJson, readJsonl, writeJson, writeJsonl, writeTextAtomic } from "../core/fs.ts";
import { modelRefForRole } from "../llm/service.ts";
import type { RunSession } from "../pipeline/session.ts";
import { type AgreementReport, agreementCell, allCodersAlpha } from "./agreement.ts";
import { buildItemPool } from "./disagreements.ts";
import { buildGroundTruth, formatCodebook } from "./ground-truth.ts";
import { loadHumanJudgments } from "./human.ts";
import { judgeAll } from "./judge.ts";
import { recodeAll } from "./recode.ts";
import { type EvaluationSummary, renderSummaryMarkdown, summarizeEvaluation } from "./summary.ts";
import { type DisagreementItem, EvalPaths, type JudgeRow, type RecodeRow } from "./types.ts";

export const EVALUATION_STEPS = ["recode", "agreement", "disagreements", "judge", "summary"] as const;
export type EvaluationStep = (typeof EVALUATION_STEPS)[number];

export function isEvaluationStep(value: string): value is EvaluationStep {
	return (EVALUATION_STEPS as readonly string[]).includes(value);
}

export type EvaluationEvent =
	| { type: "step_start"; step: EvaluationStep; detail: string }
	| { type: "progress"; step: EvaluationStep; detail: string; done: number; total: number }
	| { type: "step_end"; step: EvaluationStep; detail: string };

export interface EvaluationOptions {
	steps?: readonly EvaluationStep[] | undefined;
	signal?: AbortSignal | undefined;
	onEvent?: ((event: EvaluationEvent) => void) | undefined;
}

export interface EvaluationOutcome {
	paths: EvalPaths;
	stepsRun: EvaluationStep[];
	summary: EvaluationSummary | null;
	notes: string[];
}

export class EvaluationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvaluationError";
	}
}

export function deductiveModels(session: RunSession): string[] {
	const { models } = session.config;
	return models.deductive.length ? [...models.deductive] : [modelRefForRole(models, "coder")];
}

/**
 * The evaluation half of paper Fig. 1: deductive recoding at each codebook detail level,
 * Krippendorff's alpha against the inductive agent, the de-duplicated disagreement pool,
 * blind LLM judges, and a summary that also folds in human judgments.
 */
export async function runEvaluation(session: RunSession, options: EvaluationOptions = {}): Promise<EvaluationOutcome> {
	const steps = new Set(options.steps ?? EVALUATION_STEPS);
	const config = session.config;
	const paths = new EvalPaths(session.paths.evaluation);
	const llm = session.llm.forStage("evaluation");
	const emit = options.onEvent ?? (() => {});
	const notes: string[] = [];
	const levels = [...new Set(config.evaluation.levels)];
	const deductive = deductiveModels(session);
	const judges = [...config.models.judges];
	const evidence = config.enrichment.dimensionEvidence;

	const needsModels = [...(steps.has("recode") ? deductive : []), ...(steps.has("judge") ? judges : [])];
	session.llm.validateModels(needsModels);

	const recodeRows = async (model: string, level: DetailLevel): Promise<RecodeRow[]> =>
		readJsonl<RecodeRow>(paths.recode(model, level));
	const unresolvedCount = async (model: string, level: DetailLevel) =>
		(await readJsonl(paths.recodeUnresolved(model, level))).length;

	try {
		if (steps.has("recode")) {
			const dimsPath = session.store.dimensionsPath(evidence);
			if (!(await fileExists(dimsPath))) {
				throw new EvaluationError(
					`Evaluation needs enriched meta-themes (${dimsPath}). Enable enrichment and run the pipeline through dimension_enrichment first.`,
				);
			}
			const dimensions = await session.store.dimensions(evidence);
			const rows = buildGroundTruth(
				await session.store.openCodesMarkdown(),
				await session.store.clustered(),
				dimensions,
			);
			if (rows.length === 0) throw new EvaluationError("No quotes map to a meta-theme; nothing to recode.");
			for (const level of levels) {
				const codebook = formatCodebook(dimensions.meta_themes_enriched, level);
				for (const model of deductive) {
					emit({ type: "step_start", step: "recode", detail: `${model} @ ${level} (${rows.length} quotes)` });
					const result = await recodeAll(rows, {
						llm,
						model,
						codebook,
						level,
						settings: config.evaluation.recode,
						seed: config.seed,
						files: {
							output: paths.recode(model, level),
							unresolved: paths.recodeUnresolved(model, level),
							checkpoint: paths.recodeCheckpoint(model, level),
						},
						logger: session.logger,
						signal: options.signal,
						onProgress: (done, total) =>
							emit({ type: "progress", step: "recode", detail: `${model} @ ${level}`, done, total }),
					});
					if (result.unresolved.length)
						notes.push(`${model} @ ${level}: ${result.unresolved.length} quote(s) unresolved`);
					emit({
						type: "step_end",
						step: "recode",
						detail: `${model} @ ${level}: ${result.rows.length} classified`,
					});
				}
			}
		}

		let agreement: AgreementReport | null = (await fileExists(paths.agreement))
			? await readJson<AgreementReport>(paths.agreement)
			: null;
		if (steps.has("agreement")) {
			emit({ type: "step_start", step: "agreement", detail: "Krippendorff's alpha" });
			agreement = { levels: [] };
			for (const level of levels) {
				const byModel = new Map<string, RecodeRow[]>();
				const cells = [];
				for (const model of deductive) {
					const rows = await recodeRows(model, level);
					if (rows.length === 0) continue;
					byModel.set(model, rows);
					cells.push(agreementCell(model, level, rows, await unresolvedCount(model, level)));
				}
				if (cells.length) agreement.levels.push({ level, alpha_all_coders: allCodersAlpha(byModel), cells });
			}
			if (agreement.levels.length === 0)
				throw new EvaluationError("No recoding results yet; run the recode step first.");
			await writeJson(paths.agreement, agreement);
			emit({ type: "step_end", step: "agreement", detail: `${agreement.levels.length} level(s)` });
		}

		let items: DisagreementItem[] = await readJsonl<DisagreementItem>(paths.itemPool);
		if (steps.has("disagreements")) {
			const level = config.evaluation.judge.level;
			emit({ type: "step_start", step: "disagreements", detail: `level ${level}` });
			const byModel = new Map<string, RecodeRow[]>();
			for (const model of deductive) byModel.set(model, await recodeRows(model, level));
			const dimensions = await session.store.dimensions(evidence);
			items = buildItemPool(byModel, dimensions.meta_themes_enriched, config.seed);
			await writeJsonl(paths.itemPool, items);
			emit({ type: "step_end", step: "disagreements", detail: `${items.length} item(s)` });
		}

		const judgeRows: JudgeRow[] = [];
		if (steps.has("judge")) {
			if (judges.length === 0) notes.push("No judge models configured (models.judges); LLM judging skipped.");
			for (const model of judges) {
				emit({ type: "step_start", step: "judge", detail: `${model} (${items.length} items)` });
				const { rows, unresolved } = await judgeAll(items, {
					llm,
					model,
					settings: config.evaluation.judge,
					seed: config.seed,
					files: { output: paths.judge(model), checkpoint: paths.judgeCheckpoint(model) },
					logger: session.logger,
					signal: options.signal,
					onProgress: (done, total) => emit({ type: "progress", step: "judge", detail: model, done, total }),
				});
				judgeRows.push(...rows);
				if (unresolved) notes.push(`${model}: ${unresolved} item(s) unresolved`);
				emit({
					type: "step_end",
					step: "judge",
					detail: `${model}: ${rows.filter((r) => r.status === "judged").length} judged`,
				});
			}
		} else {
			for (const model of judges) judgeRows.push(...(await readJsonl<JudgeRow>(paths.judge(model))));
		}

		let summary: EvaluationSummary | null = null;
		if (steps.has("summary")) {
			emit({ type: "step_start", step: "summary", detail: "" });
			summary = summarizeEvaluation({
				items: items.length,
				agreement,
				judgeRows,
				humanJudgments: await loadHumanJudgments(paths),
			});
			await writeJson(paths.summaryJson, summary);
			await writeTextAtomic(paths.summaryMarkdown, renderSummaryMarkdown(summary));
			emit({ type: "step_end", step: "summary", detail: paths.summaryMarkdown });
		}
		return { paths, stepsRun: EVALUATION_STEPS.filter((s) => steps.has(s)), summary, notes };
	} finally {
		await session.logger.flush();
		await session.usage.flush();
	}
}
