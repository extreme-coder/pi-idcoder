import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DimensionsEnrichedFile, EnrichedEntry } from "../../src/artifacts/types.ts";
import { fileExists, readJson, readJsonl } from "../../src/core/fs.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { agreementCell, allCodersAlpha, renderAgreementMarkdown } from "../../src/evaluation/agreement.ts";
import { buildItemPool } from "../../src/evaluation/disagreements.ts";
import { buildGroundTruth, formatCodebook, judgeOption } from "../../src/evaluation/ground-truth.ts";
import { itemsForAnnotator, loadHumanJudgments, makeJudgment, recordJudgment } from "../../src/evaluation/human.ts";
import { judgeAll, judgeBatch, normalizeVerdict } from "../../src/evaluation/judge.ts";
import { krippendorffAlphaNominal } from "../../src/evaluation/krippendorff.ts";
import { classifyBatch, recodeAll, toRecodeRow } from "../../src/evaluation/recode.ts";
import { deductiveModels, runEvaluation } from "../../src/evaluation/runner.ts";
import { renderSummaryMarkdown, summarizeEvaluation } from "../../src/evaluation/summary.ts";
import {
	type DisagreementItem,
	EvalPaths,
	type GroundTruthRow,
	modelSlug,
	preferenceOf,
	type RecodeRow,
} from "../../src/evaluation/types.ts";
import { RunSession } from "../../src/pipeline/session.ts";
import { pausingReviewGateway } from "../../src/review/gateway.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";
import { ScriptedLlm } from "../helpers/fake-llm.ts";
import { tempProject, testConfig, writeCorpus } from "../helpers/harness.ts";
import { gameReviews, SimulatedGateway } from "../helpers/simulated-llm.ts";

const golden = JSON.parse(
	readFileSync(new URL("../fixtures/reference/format_codebook.json", import.meta.url), "utf8"),
) as {
	entries: EnrichedEntry[];
	theme_only: string;
	theme_def: string;
	full: string;
};

const dims: DimensionsEnrichedFile = {
	enriched_schema_version: 1,
	meta_themes_enriched: [
		{
			label: "Perf",
			definition: "d0",
			keywords: [],
			inclusion: [{ criterion: "i0", code_ids: [] }],
			exclusion: [],
			cluster_ids: ["0"],
		},
		{
			label: "Money",
			definition: "d1",
			keywords: [],
			inclusion: [],
			exclusion: [{ criterion: "e1", code_ids: [] }],
			cluster_ids: ["1", "2"],
		},
	],
};

const MD = `## Review 1

- Code: lag a
  Evidence: "q1"

- Code: Price A
  Evidence: "q2"

## Review 2

- Code: unknown code
  Evidence: "q3"

- Code: price b
  Evidence: "q4"
`;

const truthRow = (i: number, truth: number): GroundTruthRow => ({
	review_idx: i,
	open_code: `c${i}`,
	quote: `quote ${i}`,
	sibling_quotes: [],
	true_meta_theme_idx: truth,
	true_meta_theme_label: dims.meta_themes_enriched[truth]!.label,
});

describe("ground truth and codebook formatting", () => {
	it.each(["theme_only", "theme_def", "full"] as const)(
		"formats the %s codebook exactly like format_codebook()",
		(level) => {
			expect(formatCodebook(golden.entries, level).text).toBe(golden[level]);
		},
	);

	it("maps quotes through clusters (and dedup aliases) to meta-themes", () => {
		const rows = buildGroundTruth(
			MD,
			{
				cluster_to_codes: { "0": ["lag a"], "1": ["price a"], "2": ["price b"] },
				dedup_map: { "Price A": "price a" },
			},
			dims,
		);
		expect(rows.map((r) => [r.quote, r.true_meta_theme_label])).toEqual([
			["q1", "Perf"],
			["q2", "Money"],
			["q4", "Money"],
		]);
		expect(rows[0]!.sibling_quotes).toEqual(["q2"]);
	});

	it("builds judge options from entries", () => {
		expect(judgeOption(dims.meta_themes_enriched[0], "Perf")).toEqual({
			label: "Perf",
			definition: "d0",
			inclusion: ["i0"],
			exclusion: [],
		});
		expect(judgeOption(undefined, "X")).toEqual({ label: "X", definition: "", inclusion: [], exclusion: [] });
	});
});

describe("deductive recoding", () => {
	const codebook = formatCodebook(dims.meta_themes_enriched, "full");
	const request = (llm: ScriptedLlm, quotes = ["a", "b", "c", "d", "e"]) => ({
		llm,
		model: "x/deductive",
		codebook,
		quotes,
		level: "full" as const,
		includeReasoning: false,
		maxRetries: 2,
		logger: silentLogger,
	});

	it("accepts a batch when at least 80% of quotes are labelled", async () => {
		const llm = new ScriptedLlm({
			deductive_recode: JSON.stringify({
				classifications: [
					{ quote_index: 1, meta_theme: "a" },
					{ quote_index: 2, meta_theme: "NONE" },
					{ quote_index: 3, meta_theme: "B" },
					{ quote_index: 4, meta_theme: "B" },
					{ quote_index: 9, meta_theme: "A" },
					{ quote_index: 5, meta_theme: "Z" },
				],
			}),
		});
		const result = await classifyBatch(request(llm));
		expect([...result]).toEqual([
			[1, "A"],
			[2, "NONE"],
			[3, "B"],
			[4, "B"],
		]);
		expect(llm.calls[0]).toMatchObject({ model: "x/deductive", temperature: 0, maxTokens: 4000 });
		expect(llm.calls[0]!.system).toContain(
			"based ONLY on the written LABEL, DEFINITION, and INCLUSION/EXCLUSION criteria",
		);
	});

	it("retries partial or broken responses and gives up with an empty map", async () => {
		const llm = new ScriptedLlm({ deductive_recode: '{"classifications": [{"quote_index": 1, "meta_theme": "A"}]}' });
		expect((await classifyBatch(request(llm))).size).toBe(0);
		expect(llm.calls).toHaveLength(3);
		const broken = new ScriptedLlm({ deductive_recode: new Error("timeout") });
		expect((await classifyBatch(request(broken, ["a"]))).size).toBe(0);
	});

	it("never counts failures as disagreements", () => {
		expect(toRecodeRow(truthRow(1, 0), "A", codebook, "full", "m")).toMatchObject({
			status: "classified",
			agree: true,
			pred_meta_theme_label: "Perf",
		});
		expect(toRecodeRow(truthRow(1, 0), "B", codebook, "full", "m")).toMatchObject({
			agree: false,
			pred_meta_theme_idx: 1,
		});
		expect(toRecodeRow(truthRow(1, 0), "NONE", codebook, "full", "m")).toMatchObject({
			status: "classified",
			agree: false,
			pred_meta_theme_label: "NONE",
		});
		expect(toRecodeRow(truthRow(1, 0), undefined, codebook, "full", "m")).toMatchObject({
			status: "call_failed",
			agree: null,
		});
	});

	it("checkpoints classified rows, retries failures in rounds, and writes unresolved quotes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-eval-"));
		const files = {
			output: join(dir, "out.jsonl"),
			unresolved: join(dir, "unresolved.jsonl"),
			checkpoint: join(dir, "cp.jsonl"),
		};
		const rows = [truthRow(1, 0), truthRow(2, 1), truthRow(3, 1)];
		let calls = 0;
		const llm = new ScriptedLlm({
			deductive_recode: (req) => {
				calls++;
				if (req.prompt.includes('"quote 3"')) return "{}";
				const n = (req.prompt.match(/^\d+\. "/gm) ?? []).length;
				return JSON.stringify({
					classifications: Array.from({ length: n }, (_, i) => ({ quote_index: i + 1, meta_theme: "B" })),
				});
			},
		});
		const settings = { batchSize: 1, workers: 1, maxRounds: 2, maxRetries: 0, includeReasoning: false };
		const deps = {
			llm,
			model: "m",
			codebook,
			level: "full" as const,
			settings,
			seed: 1,
			files,
			logger: silentLogger,
		};
		const result = await recodeAll(rows, deps);
		expect(result.rows.map((r) => r.review_idx)).toEqual([1, 2]);
		expect(result.unresolved.map((r) => r.review_idx)).toEqual([3]);
		expect(result.rounds).toBe(2);
		expect(calls).toBe(5);
		expect(await readJsonl(files.unresolved)).toHaveLength(1);

		const again = await recodeAll(rows, { ...deps, settings: { ...settings, maxRounds: 0 } });
		expect(calls).toBe(6);
		expect(again.rows).toHaveLength(2);
	});
});

describe("recode checkpoints", () => {
	it("ignore results recorded against a different codebook or ground truth", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-eval-"));
		const files = {
			output: join(dir, "o.jsonl"),
			unresolved: join(dir, "u.jsonl"),
			checkpoint: join(dir, "c.jsonl"),
		};
		const llm = new ScriptedLlm({
			deductive_recode: (req) => {
				const n = (req.prompt.match(/^\d+\. "/gm) ?? []).length;
				return JSON.stringify({
					classifications: Array.from({ length: n }, (_, i) => ({ quote_index: i + 1, meta_theme: "A" })),
				});
			},
		});
		const settings = { batchSize: 5, workers: 1, maxRounds: 0, maxRetries: 0, includeReasoning: false };
		const deps = (cb: ReturnType<typeof formatCodebook>) => ({
			llm,
			model: "m",
			codebook: cb,
			level: "full" as const,
			settings,
			seed: 1,
			files,
			logger: silentLogger,
		});
		const rows = [truthRow(1, 0), truthRow(2, 1)];
		await recodeAll(rows, deps(formatCodebook(dims.meta_themes_enriched, "full")));
		await recodeAll(rows, deps(formatCodebook(dims.meta_themes_enriched, "full")));
		expect(llm.calls).toHaveLength(1);
		const edited = dims.meta_themes_enriched.map((e) => ({ ...e, definition: `${e.definition}!` }));
		await recodeAll(rows, deps(formatCodebook(edited, "full")));
		expect(llm.calls).toHaveLength(2);
		await recodeAll([truthRow(1, 1), truthRow(2, 1)], deps(formatCodebook(edited, "full")));
		expect(llm.calls).toHaveLength(3);
	});
});

describe("agreement", () => {
	const codebook = formatCodebook(dims.meta_themes_enriched, "full");
	const rows: RecodeRow[] = [
		toRecodeRow(truthRow(1, 0), "A", codebook, "full", "m"),
		toRecodeRow(truthRow(2, 1), "B", codebook, "full", "m"),
		toRecodeRow(truthRow(3, 1), "NONE", codebook, "full", "m"),
		toRecodeRow(truthRow(4, 0), "A", codebook, "full", "m"),
	];

	it("computes alpha and agreement with NONE as a category", () => {
		const cell = agreementCell("m", "full", rows, 2);
		expect(cell).toMatchObject({ n_total: 6, n_classified: 4, n_unresolved: 2, n_none: 1, percent_agreement: 0.75 });
		expect(cell.alpha).toBeGreaterThan(0);
		expect(cell.alpha).toBeLessThan(1);
		expect(agreementCell("m", "full", [], 0)).toMatchObject({ alpha: null, percent_agreement: null });
	});

	it("computes alpha across all coders with missing values", () => {
		const second = rows.map((r) => ({ ...r, classifier_model: "n" }));
		const failed = { ...second[0]!, status: "call_failed" as const, pred_meta_theme_idx: null };
		expect(
			allCodersAlpha(
				new Map([
					["m", rows],
					["n", [failed, ...second.slice(1)]],
				]),
			),
		).toBeCloseTo(
			krippendorffAlphaNominal([
				["0", "0", null],
				["1", "1", "1"],
				["1", "NONE", "NONE"],
				["0", "0", "0"],
			]),
			12,
		);
		const markdown = renderAgreementMarkdown({
			levels: [{ level: "full", alpha_all_coders: null, cells: [agreementCell("m", "full", rows, 0)] }],
		});
		expect(markdown).toContain("| full | m |");
		expect(markdown).toContain("75.0%");
	});
});

describe("disagreement items", () => {
	const codebook = formatCodebook(dims.meta_themes_enriched, "full");
	const rowsA = [
		toRecodeRow(truthRow(1, 0), "B", codebook, "full", "m1"),
		toRecodeRow(truthRow(2, 0), "A", codebook, "full", "m1"),
	];
	const rowsB = [
		toRecodeRow(truthRow(1, 0), "B", codebook, "full", "m2"),
		toRecodeRow(truthRow(3, 1), "NONE", codebook, "full", "m2"),
	];

	it("dedupes across agents, skips NONE and agreement, and randomizes sides reproducibly", () => {
		const items = buildItemPool(
			new Map([
				["m1", rowsA],
				["m2", rowsB],
			]),
			dims.meta_themes_enriched,
			7,
		);
		expect(items).toHaveLength(1);
		const [item] = items;
		expect(item).toMatchObject({ raised_by: ["m1", "m2"], true_label: "Perf", pred_label: "Money" });
		expect(item!.item_id).toMatch(/^item_[0-9a-f]{16}$/);
		const inductive = item!.true_side === "A" ? item!.option_a : item!.option_b;
		expect(inductive).toEqual({ label: "Perf", definition: "d0", inclusion: ["i0"], exclusion: [] });
		expect(buildItemPool(new Map([["m1", rowsA]]), dims.meta_themes_enriched, 7)[0]!.true_side).toBe(item!.true_side);
	});

	it("keeps ids and sides stable when other items appear, and changes them when the codebook text changes", () => {
		const extra = toRecodeRow(truthRow(9, 1), "A", codebook, "full", "m1");
		const before = buildItemPool(new Map([["m1", rowsA]]), dims.meta_themes_enriched, 7)[0]!;
		const after = buildItemPool(new Map([["m1", [extra, ...rowsA]]]), dims.meta_themes_enriched, 7);
		expect(after.find((i) => i.item_id === before.item_id)).toEqual(before);
		const edited = dims.meta_themes_enriched.map((e, i) => (i === 0 ? { ...e, definition: "rewritten" } : e));
		expect(buildItemPool(new Map([["m1", rowsA]]), edited, 7)[0]!.item_id).not.toBe(before.item_id);
	});

	it("balances sides over many items", () => {
		const many = Array.from({ length: 400 }, (_, i) =>
			toRecodeRow({ ...truthRow(i, 0), open_code: `c${i}` }, "B", codebook, "full", "m"),
		);
		const sides = buildItemPool(new Map([["m", many]]), dims.meta_themes_enriched, 3).map((i) => i.true_side);
		const share = sides.filter((s) => s === "A").length / sides.length;
		expect(share).toBeGreaterThan(0.4);
		expect(share).toBeLessThan(0.6);
	});
});

const item = (n: number, trueSide: "A" | "B" = "A"): DisagreementItem => ({
	item_id: `item_${n}`,
	review_idx: n,
	open_code: "c",
	quote: `q${n}`,
	option_a: { label: "A", definition: "", inclusion: [], exclusion: [] },
	option_b: { label: "B", definition: "", inclusion: [], exclusion: [] },
	true_side: trueSide,
	true_label: trueSide === "A" ? "A" : "B",
	pred_label: trueSide === "A" ? "B" : "A",
	raised_by: ["m"],
});

describe("LLM judges", () => {
	it("normalizes verdicts per outcome set", () => {
		expect(normalizeVerdict("Option B.", "binary")).toBe("B");
		expect(normalizeVerdict("a", "binary")).toBe("A");
		expect(normalizeVerdict("BOTH", "binary")).toBe("");
		expect(normalizeVerdict("both fit", "four_way")).toBe("BOTH");
		expect(normalizeVerdict("None", "four_way")).toBe("NEITHER");
		expect(normalizeVerdict("neither fits", "four_way")).toBe("NEITHER");
		expect(normalizeVerdict("maybe", "four_way")).toBe("");
	});

	it("maps verdicts to preferences relative to the hidden inductive side", () => {
		expect(preferenceOf("A", "A")).toBe("inductive");
		expect(preferenceOf("A", "B")).toBe("deductive");
		expect(preferenceOf("BOTH", "B")).toBe("both");
		expect(preferenceOf("NEITHER", "A")).toBe("neither");
	});

	it("judges a batch blind", async () => {
		const llm = new ScriptedLlm({
			disagreement_judge:
				'{"verdicts": [{"item_index": 1, "pick": "Option A"}, {"item_index": 2, "pick": "NEITHER"}]}',
		});
		const verdicts = await judgeBatch({
			llm,
			model: "j",
			items: [item(1), item(2)],
			outcomes: "four_way",
			maxRetries: 0,
			logger: silentLogger,
		});
		expect([...verdicts]).toEqual([
			[1, "A"],
			[2, "NEITHER"],
		]);
		expect(llm.calls[0]!.prompt).not.toContain("true_side");
		expect(llm.calls[0]!.maxTokens).toBe(2000);
	});

	it("checkpoints judged items and never re-bills them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-judge-"));
		const files = { output: join(dir, "j.jsonl"), checkpoint: join(dir, ".j.jsonl") };
		const llm = new ScriptedLlm({
			disagreement_judge: (req) => {
				const n = (req.prompt.match(/^\d+\. QUOTE/gm) ?? []).length;
				return JSON.stringify({
					verdicts: Array.from({ length: n }, (_, i) => ({ item_index: i + 1, pick: "B" })),
				});
			},
		});
		const settings = {
			outcomes: "four_way" as const,
			level: "full" as const,
			batchSize: 2,
			workers: 2,
			maxRounds: 1,
			maxRetries: 0,
		};
		const items = [item(1), item(2, "B"), item(3)];
		const first = await judgeAll(items, { llm, model: "j", settings, seed: 1, files, logger: silentLogger });
		expect(first.rows.map((r) => r.preferred)).toEqual(["deductive", "inductive", "deductive"]);
		expect(first.unresolved).toBe(0);
		await judgeAll(items, { llm, model: "j", settings, seed: 1, files, logger: silentLogger });
		expect(llm.calls).toHaveLength(2);
	});

	it("reports unresolved items after the retry rounds", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-judge-"));
		const llm = new ScriptedLlm({ disagreement_judge: "{}" });
		const result = await judgeAll([item(1)], {
			llm,
			model: "j",
			settings: { outcomes: "binary", level: "full", batchSize: 5, workers: 1, maxRounds: 2, maxRetries: 0 },
			seed: 1,
			files: { output: join(dir, "o.jsonl"), checkpoint: join(dir, "c.jsonl") },
			logger: silentLogger,
		});
		expect(result.unresolved).toBe(1);
		expect(result.rows[0]).toMatchObject({ status: "call_failed", preferred: null });
		expect(llm.calls).toHaveLength(3);
	});
});

describe("human judgments", () => {
	const pool = Array.from({ length: 20 }, (_, i) => item(i));

	it("gives every annotator the same shared sample in their own order", () => {
		const alice = itemsForAnnotator(pool, "alice", new Set(), 5, 9);
		const bob = itemsForAnnotator(pool, "bob", new Set(), 5, 9);
		expect(new Set(alice.map((i) => i.item_id))).toEqual(new Set(bob.map((i) => i.item_id)));
		expect(alice.map((i) => i.item_id)).not.toEqual(bob.map((i) => i.item_id));
		expect(itemsForAnnotator(pool, "alice", new Set([alice[0]!.item_id]), 5, 9)).toHaveLength(4);
	});

	it("records judgments and keeps the latest per annotator and item", async () => {
		const paths = new EvalPaths(await mkdtemp(join(tmpdir(), "idc-human-")));
		expect(await loadHumanJudgments(paths)).toEqual([]);
		await recordJudgment(paths, makeJudgment(item(1), "alice", "A"));
		await recordJudgment(paths, makeJudgment(item(1), "alice", "B"));
		await recordJudgment(paths, makeJudgment(item(1, "B"), "bob", "BOTH"));
		const all = await loadHumanJudgments(paths);
		expect(all.map((j) => [j.annotator, j.verdict, j.preferred])).toEqual([
			["alice", "B", "deductive"],
			["bob", "BOTH", "both"],
		]);
		expect(await fileExists(paths.human("alice"))).toBe(true);
	});
});

describe("summary", () => {
	it("summarizes judges and humans, including majority agreement", () => {
		const summary = summarizeEvaluation({
			items: 2,
			agreement: null,
			judgeRows: [
				{ item_id: "1", judge: "j1", verdict: "A", status: "judged", preferred: "deductive" },
				{ item_id: "1", judge: "j2", verdict: "A", status: "judged", preferred: "deductive" },
				{ item_id: "2", judge: "j1", verdict: "B", status: "judged", preferred: "inductive" },
				{ item_id: "2", judge: "j2", verdict: "", status: "call_failed", preferred: null },
			],
			humanJudgments: [
				{ item_id: "1", annotator: "h1", verdict: "A", preferred: "deductive", ts: "" },
				{ item_id: "1", annotator: "h2", verdict: "A", preferred: "deductive", ts: "" },
			],
		});
		expect(summary.llm_judges).toMatchObject({
			raters: 2,
			judgments: 3,
			items: 2,
			distribution: { deductive: 2, inductive: 1 },
		});
		expect(summary.llm_judges!.deductive_share_of_decisive).toBeCloseTo(2 / 3);
		expect(summary.llm_judges!.per_judge.j1).toEqual({ inductive: 1, deductive: 1, both: 0, neither: 0 });
		expect(summary.humans!.per_annotator).toEqual({ h1: 1, h2: 1 });
		expect(summary.human_llm_majority_agreement).toBe(1);
		const markdown = renderSummaryMarkdown(summary);
		expect(markdown).toContain("## LLM judges");
		expect(markdown).toContain("| deductive theme | 2 | 66.7% |");
		expect(markdown).toContain("Human majority matches LLM majority on 100.0%");
	});

	it("handles empty inputs", () => {
		const summary = summarizeEvaluation({ items: 0, agreement: null, judgeRows: [], humanJudgments: [] });
		expect(summary).toMatchObject({ llm_judges: null, humans: null, human_llm_majority_agreement: null });
		expect(renderSummaryMarkdown(summary)).toContain("Disagreement items: 0");
	});

	it("slugs model refs for file names", () => {
		expect(modelSlug("opencode/google/gemma-4:free")).toBe("opencode__google__gemma-4__free");
	});
});

describe("evaluation end to end (simulated models)", () => {
	async function completedRun(models: NonNullable<Parameters<typeof testConfig>[0]>["models"]) {
		const projectDir = await tempProject();
		await writeCorpus(projectDir, gameReviews());
		const config = testConfig({ review: { enabled: false }, clustering: { kMin: 2, kMaxCap: 8 }, models });
		const gateway = new SimulatedGateway();
		const session = new RunSession({ projectDir, config, gateway, embedder: new HashingEmbedder(), retryBaseMs: 0 });
		expect((await session.run({ review: pausingReviewGateway })).status).toBe("completed");
		return { session, gateway };
	}

	it("recodes at every level, measures alpha, builds items, judges, and summarizes", async () => {
		const { session, gateway } = await completedRun({
			deductive: ["sim/qwen", "sim/gemma"],
			judges: ["sim/judge-a", "sim/judge-b"],
		});
		const events: string[] = [];
		const outcome = await runEvaluation(session, {
			onEvent: (e) => e.type !== "progress" && events.push(`${e.type}:${e.step}`),
		});
		expect(outcome.stepsRun).toEqual(["recode", "agreement", "disagreements", "judge", "summary"]);

		const agreement = await readJson<{
			levels: Array<{ level: string; cells: Array<{ model: string; alpha: number | null }> }>;
		}>(outcome.paths.agreement);
		expect(agreement.levels.map((l) => l.level)).toEqual(["theme_only", "theme_def", "full"]);
		expect(agreement.levels[0]!.cells.map((c) => c.model)).toEqual(["sim/qwen", "sim/gemma"]);

		const items = await readJsonl<DisagreementItem>(outcome.paths.itemPool);
		expect(items.length).toBeGreaterThan(0);
		const judged = await readJsonl(outcome.paths.judge("sim/judge-a"));
		expect(judged).toHaveLength(items.length);
		expect(outcome.summary!.llm_judges!.raters).toBe(2);
		expect(await fileExists(outcome.paths.summaryMarkdown)).toBe(true);
		expect(events).toContain("step_end:summary");

		const recodeCalls = gateway.calls.filter((c) => c.skill === "deductive_recode");
		expect(new Set(recodeCalls.map((c) => c.ref))).toEqual(new Set(["sim/qwen", "sim/gemma"]));
		expect(recodeCalls.some((c) => c.request.prompt.includes("INCLUSION CRITERIA"))).toBe(true);
		expect(recodeCalls.some((c) => !c.request.prompt.includes("DEFINITION:"))).toBe(true);

		await recordJudgment(outcome.paths, makeJudgment({ ...items[0]!, item_id: "item_gone" }, "ana", "A"));
		await recordJudgment(outcome.paths, makeJudgment(items[0]!, "ana", "A"));
		const before = gateway.calls.length;
		const rerun = await runEvaluation(session, { steps: ["recode", "judge", "summary"] });
		expect(rerun.summary!.humans!.judgments).toBe(1);
		expect(gateway.calls.length).toBe(before);
		expect(rerun.summary!.items).toBe(items.length);
	});

	it("defaults the deductive agent to the coder and skips judging without judges", async () => {
		const { session } = await completedRun({});
		expect(deductiveModels(session)).toEqual(["current"]);
		const outcome = await runEvaluation(session, { steps: ["recode", "agreement", "disagreements", "judge"] });
		expect(outcome.notes).toContain("No judge models configured (models.judges); LLM judging skipped.");
		expect(outcome.summary).toBeNull();
	});

	it("explains what is missing before the pipeline has produced dimensions", async () => {
		const projectDir = await tempProject();
		const session = new RunSession({
			projectDir,
			config: testConfig(),
			gateway: new SimulatedGateway(),
			embedder: new HashingEmbedder(),
		});
		await expect(runEvaluation(session)).rejects.toThrow(/Enable enrichment and run the pipeline/);
		await expect(runEvaluation(session, { steps: ["agreement"] })).rejects.toThrow(/run the recode step first/);
	});
});
