import { describe, expect, it } from "vitest";
import {
	assignIntegerClusterIds,
	buildHicodeMapping,
	clusterByLlm,
	completionBudget,
	pythonListRepr,
} from "../../src/cluster/axial-llm.ts";
import { readJson, readJsonl, writeJson } from "../../src/core/fs.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { Rng } from "../../src/core/random.ts";
import type { CorpusDocument } from "../../src/corpus/load.ts";
import { labelBySampling, labelFirstN, labelingStage, parseLabelResponse } from "../../src/stages/labeling.ts";
import {
	codeDocument,
	codesOnlyFromCoded,
	EMPTY_OUTPUT_PLACEHOLDER,
	openCodingStage,
	parseValidation,
	renderOpenCodesMarkdown,
} from "../../src/stages/open-coding.ts";
import { applyMoves, dedupeMoves, parseMoveLine, pruneHierarchy, refineStage } from "../../src/stages/refine.ts";
import { ScriptedLlm } from "../helpers/fake-llm.ts";
import { makeContext, testConfig } from "../helpers/harness.ts";

const doc = (reviewId: number, text: string): CorpusDocument => ({ reviewId, text, sourceId: null });

describe("open coding", () => {
	it("parses validator verdicts like the original state machine", () => {
		expect(parseValidation("PASS\nLooks good.")).toEqual({ verdict: "PASS", feedback: "PASS\nLooks good." });
		expect(parseValidation("  fail\nIssues listed").verdict).toBe("FAIL");
		expect(parseValidation("pass").verdict).toBe("PASS");
		expect(parseValidation("").verdict).toBe("FAIL");
	});

	it("codes once without the validator and substitutes NONE for empty output", async () => {
		const llm = new ScriptedLlm({ open_coding: "<think>hmm</think>   " });
		const coded = await codeDocument(llm, "RQ", doc(1, "text"), { validator: false, maxRetries: 2, workers: 1 });
		expect(coded.output).toBe(EMPTY_OUTPUT_PLACEHOLDER);
		expect(coded.attempts).toBe(1);
		expect(coded.validation).toBeUndefined();
		expect(llm.calls[0]!.prompt).toContain("Research Question: RQ");
	});

	it("revises with validator feedback until PASS", async () => {
		let n = 0;
		const llm = new ScriptedLlm({
			open_coding: (req) =>
				req.prompt.includes("A reviewer found issues") ? "- Code: better code" : "- Code: vague",
			validate_open_codes: () => (++n === 1 ? "FAIL\n- too vague" : "PASS"),
		});
		const coded = await codeDocument(llm, "RQ", doc(1, "t"), { validator: true, maxRetries: 2, workers: 1 });
		expect(coded).toMatchObject({ output: "- Code: better code", attempts: 2, validation: "PASS" });
		expect(llm.callsFor("open_coding")[1]!.prompt).toContain("FAIL\n- too vague");
		expect(llm.callsFor("validate_open_codes")[0]!.role).toBe("validator");
	});

	it("keeps the last attempt once retries are exhausted", async () => {
		const llm = new ScriptedLlm({ open_coding: "- Code: x", validate_open_codes: "FAIL\n- nope" });
		const coded = await codeDocument(llm, "RQ", doc(1, "t"), { validator: true, maxRetries: 2, workers: 1 });
		expect(coded).toMatchObject({ attempts: 3, validation: "FAIL" });
		expect(llm.callsFor("open_coding")).toHaveLength(3);
	});

	it("renders markdown and extracts codes per review", () => {
		const coded = [
			{ review_id: 1, text_hash: "a", output: '- Code: a\n  Evidence: "x"', attempts: 1 },
			{ review_id: 2, text_hash: "b", output: EMPTY_OUTPUT_PLACEHOLDER, attempts: 1 },
		];
		expect(renderOpenCodesMarkdown(coded)).toBe(
			`## Review 1\n\n- Code: a\n  Evidence: "x"\n\n## Review 2\n\n${EMPTY_OUTPUT_PLACEHOLDER}\n\n`,
		);
		expect(codesOnlyFromCoded(coded)).toEqual({
			all_codes: ["a"],
			codes_per_review: [
				[1, ["a"]],
				[2, []],
			],
		});
	});

	it("reuses checkpointed documents unless their text changed", async () => {
		const llm = new ScriptedLlm({ open_coding: (r) => `- Code: ${r.prompt.includes("second") ? "two" : "one"}` });
		const docs = [doc(1, "first text"), doc(2, "second text")];
		const ctx = await makeContext({ llm, documents: docs });
		await openCodingStage.run(ctx);
		expect(llm.calls).toHaveLength(2);
		expect(ctx.progressUpdates.at(-1)).toMatchObject({ done: 2, total: 2 });

		const ctx2 = await makeContext({
			llm,
			projectDir: ctx.projectDir,
			documents: [docs[0]!, doc(2, "second text, edited")],
		});
		const outcome = await openCodingStage.run(ctx2);
		expect(llm.calls).toHaveLength(3);
		expect(outcome).toMatchObject({ status: "done", metrics: { codes: 2, documents: 2 } });
		expect((await readJson<{ all_codes: string[] }>(ctx.paths.codesOnly)).all_codes).toEqual(["one", "two"]);
		expect(openCodingStage.checkpoints!(ctx.paths)).toEqual([ctx.paths.openCodingCheckpoint]);
	});
});

describe("cluster labeling", () => {
	const deps = (
		llm: ScriptedLlm,
		settings = { strategy: "nsampling" as const, samples: 3, sampleSize: 2, workers: 2, lowConfidenceThreshold: 2 },
	) => ({
		llm,
		researchQuestion: "RQ",
		settings,
		rng: new Rng(1),
		logger: silentLogger,
	});

	it("parses and clamps label responses", () => {
		expect(parseLabelResponse('{"label": "\\"Lag\\"", "confidence": "9", "rationale": " r "}')).toEqual({
			label: "Lag",
			confidence: 5,
			rationale: "r",
		});
	});

	it("labels from the first 30 codes and notes the overflow", async () => {
		const llm = new ScriptedLlm({
			high_level_code_generation: '{"label": "Lag", "confidence": 4, "rationale": "r"}',
		});
		const codes = Array.from({ length: 33 }, (_, i) => `c${i}`);
		expect(await labelFirstN("7", codes, deps(llm))).toEqual({ label: "Lag", confidence: 4, rationale: "r" });
		expect(llm.calls[0]!.prompt).toContain("- ... and 3 more");
		expect(llm.calls[0]!.prompt).not.toContain("- c30");
	});

	it("falls back to `Cluster N` on bad or failing responses", async () => {
		const long = new ScriptedLlm({
			high_level_code_generation: JSON.stringify({ label: "x".repeat(81), confidence: 3 }),
		});
		expect((await labelFirstN("4", ["a"], deps(long))).label).toBe("Cluster 4");
		const broken = new ScriptedLlm({ high_level_code_generation: new Error("boom") });
		expect(await labelFirstN("4", ["a"], deps(broken))).toEqual({ label: "Cluster 4", confidence: 1, rationale: "" });
		expect(await labelFirstN("5", [], deps(broken))).toEqual({ label: "Cluster 5", confidence: 1, rationale: "" });
	});

	it("synthesizes candidates from random samples for large clusters", async () => {
		let i = 0;
		const llm = new ScriptedLlm({
			high_level_code_generation: () => JSON.stringify({ label: ["A", "B", "A"][i++ % 3], confidence: 3 }),
			high_level_synthesis: (req) => {
				expect(req.prompt).toContain("- A\n- B\n- A");
				return '{"label": "A theme", "confidence": 2, "rationale": "split"}';
			},
		});
		const result = await labelBySampling("1", ["a", "b", "c", "d"], deps(llm));
		expect(result).toEqual({
			label: "A theme",
			confidence: 2,
			rationale: "split",
			candidate_labels: ["A", "B", "A"],
		});
		const samples = llm.callsFor("high_level_code_generation").map((c) => c.prompt.match(/^- [abcd]$/gm)!.length);
		expect(samples).toEqual([2, 2, 2]);
	});

	it("uses a single call for clusters within the sample size and degrades gracefully", async () => {
		const llm = new ScriptedLlm({ high_level_code_generation: '{"label": "Small", "confidence": 5}' });
		expect(await labelBySampling("1", ["a", "b"], deps(llm))).toMatchObject({ label: "Small", candidate_labels: [] });
		const noCandidates = new ScriptedLlm({ high_level_code_generation: new Error("x") });
		expect((await labelBySampling("2", ["a", "b", "c"], deps(noCandidates))).label).toBe("Cluster 2");
		const badSynthesis = new ScriptedLlm({
			high_level_code_generation: '{"label": "Cand", "confidence": 3}',
			high_level_synthesis: new Error("down"),
		});
		expect(await labelBySampling("3", ["a", "b", "c"], deps(badSynthesis))).toMatchObject({
			label: "Cand",
			confidence: 1,
		});
	});

	it("writes codebook and confidence, resuming from its checkpoint", async () => {
		const llm = new ScriptedLlm({ high_level_code_generation: '{"label": "L", "confidence": 1, "rationale": "r"}' });
		const ctx = await makeContext({ llm, config: testConfig({ labeling: { strategy: "first30" } }) });
		await writeJson(ctx.paths.clusteredCodes, {
			all_codes: ["a", "b"],
			labels: [0, 1],
			k: 2,
			cluster_to_codes: { "0": ["a"], "1": ["b"] },
		});
		const outcome = await labelingStage.run(ctx);
		expect(outcome).toMatchObject({ status: "done", metrics: { clusters: 2, low_confidence: 2 } });
		expect(await readJson(ctx.paths.codebook)).toEqual({
			codebook: { "0": "L", "1": "L" },
			cluster_to_codes: { "0": ["a"], "1": ["b"] },
		});
		expect(ctx.logs.filter((l) => l.event === "LOW_CONFIDENCE_CLUSTER")).toHaveLength(2);
		await labelingStage.run(ctx);
		expect(llm.calls).toHaveLength(2);
	});

	it("takes labels straight from LLM clustering when present", async () => {
		const llm = new ScriptedLlm({});
		const ctx = await makeContext({ llm });
		await writeJson(ctx.paths.clusteredCodes, {
			all_codes: ["a"],
			labels: [0],
			k: 1,
			cluster_to_codes: { "0": ["a"] },
			cluster_theme_names: { "0": "Theme" },
		});
		await labelingStage.run(ctx);
		expect(await readJson(ctx.paths.codebookConfidence)).toEqual({
			"0": { label: "Theme", confidence: 4, rationale: "from LLM axial clustering" },
		});
		expect(llm.calls).toHaveLength(0);
	});
});

describe("refinement", () => {
	it("parses MOVE lines with either arrow", () => {
		expect(parseMoveLine('MOVE: "slow load" → "Performance"')).toEqual({ code: "slow load", target: "Performance" });
		expect(parseMoveLine("move: 'x' -> 'Y'")).toEqual({ code: "x", target: "Y" });
		expect(parseMoveLine('MOVE: "x" > "Y"')).toEqual({ code: "x", target: "Y" });
		expect(parseMoveLine("NONE")).toBeUndefined();
	});

	it("keeps the first move per code and rekeys clusters", () => {
		const conflicts: string[] = [];
		const moves = dedupeMoves(
			[
				{ code: "b", from: "0", to: "2" },
				{ code: "b", from: "0", to: "1" },
				{ code: "c", from: "1", to: "2" },
			],
			(c) => conflicts.push(c),
		);
		expect(conflicts).toEqual(["b"]);
		expect(applyMoves({ "0": ["a", "b"], "1": ["c"], "2": ["d"] }, moves)).toEqual({
			clusterToCodes: { "0": ["a"], "1": ["b", "c", "d"] },
			oldIds: ["0", "2"],
		});
	});

	it("prunes stale hierarchy keys", () => {
		expect(
			pruneHierarchy(
				{
					a: { label: "x", sub_themes: [], ungrouped_codes: [] },
					orphan: { label: "o", sub_themes: [], ungrouped_codes: [] },
				},
				new Set(["a"]),
			),
		).toMatchObject({
			removed: ["orphan"],
			pruned: { a: { label: "x" } },
		});
	});

	it("applies only unambiguous moves among the most similar clusters and skips flagged clusters", async () => {
		const llm = new ScriptedLlm({
			refine_cluster_assignments: (req) => {
				if (req.prompt.includes('labeled "Lag"')) {
					return 'MOVE: "price stray" → "Price"\nMOVE: "not in chunk" → "Price"\nMOVE: "lag a" → "Dup"\nMOVE: "lag b" → "Lag"';
				}
				return "NONE";
			},
		});
		const ctx = await makeContext({ llm, config: testConfig({ refine: { topKOtherClusters: 1 } }) });
		const ctc = {
			"0": ["lag a", "lag b", "price stray"],
			"1": ["price a"],
			"2": ["d1"],
			"3": ["d2"],
			"4": ["story"],
		};
		await writeJson(ctx.paths.clusteredCodes, {
			all_codes: Object.values(ctc).flat(),
			labels: [],
			k: 5,
			cluster_to_codes: ctc,
		});
		await writeJson(ctx.paths.codebook, {
			codebook: { "0": "Lag", "1": "Price", "2": "Dup", "3": "Dup", "4": "Story" },
			cluster_to_codes: ctc,
		});
		await writeJson(ctx.paths.codebookConfidence, {
			"4": { label: "Story", confidence: 2, rationale: "", needs_more_evidence: true },
		});
		await writeJson(ctx.paths.hierarchy, {
			"4": { label: "Story", sub_themes: [], ungrouped_codes: [] },
			"9": { label: "Old", sub_themes: [], ungrouped_codes: [] },
		});

		const outcome = await refineStage.run(ctx);
		expect(outcome).toMatchObject({ metrics: { moves: 1 } });
		const cb = await readJson<{ cluster_to_codes: Record<string, string[]> }>(ctx.paths.codebook);
		// destination order follows the original code order (Python dict insertion order)
		expect(cb.cluster_to_codes["1"]).toEqual(["price stray", "price a"]);
		expect(llm.callsFor("refine_cluster_assignments").some((c) => c.prompt.includes('labeled "Story"'))).toBe(false);
		const lagPrompt = llm.calls.find((c) => c.prompt.includes('labeled "Lag"'))!.prompt;
		expect(lagPrompt.split("may not suggest any other label):\n")[1]!.split("\n")[0]!.split(", ")).toHaveLength(1);
		expect(ctx.logs.some((l) => l.event === "REFINE_SKIP_AMBIGUOUS_LABEL")).toBe(true);
		expect(Object.keys(await readJson(ctx.paths.hierarchy))).toEqual(["4"]);
		const clustered = await readJson<{ labels: number[] }>(ctx.paths.clusteredCodes);
		expect(clustered.labels).toEqual([0, 0, 1, 1, 2, 3, 4]);
	});

	it("chunks large clusters by maxCodesPerCall", async () => {
		const llm = new ScriptedLlm({ refine_cluster_assignments: "NONE" });
		const ctx = await makeContext({ llm, config: testConfig({ refine: { maxCodesPerCall: 16 } }) });
		const codes = Array.from({ length: 40 }, (_, i) => `c${i}`);
		await writeJson(ctx.paths.clusteredCodes, {
			all_codes: codes,
			labels: [],
			k: 1,
			cluster_to_codes: { "0": codes },
		});
		await writeJson(ctx.paths.codebook, { codebook: { "0": "Only" }, cluster_to_codes: { "0": codes } });
		await refineStage.run(ctx);
		expect(llm.calls.map((c) => c.labels?.chunk_index)).toEqual([0, 1, 2]);
		expect(llm.calls[0]!.prompt).toContain("(none)");
	});
});

describe("LLM axial clustering (HICode port)", () => {
	it("prints lists like Python's str()", () => {
		expect(pythonListRepr(["a", "it's", 'say "hi"', "back\\slash", "nl\n"])).toBe(
			`['a', "it's", 'say "hi"', 'back\\\\slash', 'nl\\n']`,
		);
		expect(pythonListRepr([`both ' and "`])).toBe(`['both \\' and "']`);
	});

	it("budgets completion tokens against the context window", () => {
		const settings = {
			maxIterations: 3,
			batchSize: 100,
			saveIterations: false,
			contextLength: 4000,
			maxCompletion: 8192,
		};
		expect(completionBudget("x".repeat(3000), ["a"], settings)).toBe(2615);
		expect(completionBudget("x".repeat(30000), ["a"], settings)).toBe(512);
		expect(completionBudget("", [], { ...settings, contextLength: 100000 })).toBe(8192);
	});

	it("chains labels through iterations and abandons dropped clusters", () => {
		const { finalKeyOf, display } = buildHicodeMapping([
			{ "Group A": ["x", "Y"], "Group B": ["z"] },
			{ " Theme ": ["group a"] },
		]);
		expect([...finalKeyOf]).toEqual([
			["x", "theme"],
			["y", "theme"],
		]);
		expect(display.get("theme")).toBe("Theme");
		expect(buildHicodeMapping([]).finalKeyOf.size).toBe(0);
	});

	it("orders clusters by size then name and caps label length", () => {
		expect(
			assignIntegerClusterIds({
				b: ["1"],
				A: ["2"],
				big: ["3", "4"],
				[" ".repeat(3)]: ["5"],
				["x".repeat(121)]: ["6"],
			}),
		).toEqual({
			clusterToCodes: { "0": ["3", "4"], "1": ["5"], "2": ["2"], "3": ["1"], "4": ["6"] },
			themeNames: { "0": "big", "1": "Cluster 1", "2": "A", "3": "b", "4": "Cluster 4" },
		});
	});

	it("runs batches per iteration and skips unparsable batches", async () => {
		const codes = Array.from({ length: 5 }, (_, i) => `code ${i}`);
		let call = 0;
		const llm = new ScriptedLlm({
			llm_clustering: (req) => {
				call++;
				if (req.prompt.includes("code 4")) return "garbage";
				if (req.prompt.startsWith("['code"))
					return JSON.stringify({ Even: ["code 0", "code 2"], Odd: ["code 1", "Code 3"] });
				return JSON.stringify({ All: ["Even", "Odd"] });
			},
		});
		const iterations: number[] = [];
		const { file, summary } = await clusterByLlm(codes, [[1, ["code 0"]]], {
			llm,
			researchQuestion: "RQ",
			settings: { maxIterations: 3, batchSize: 4, saveIterations: true, contextLength: 16384, maxCompletion: 8192 },
			logger: silentLogger,
			onIteration: async (i) => void iterations.push(i),
		});
		expect(call).toBe(3);
		expect(iterations).toEqual([0, 1]);
		expect(file.cluster_to_codes).toEqual({ "0": ["code 0", "code 2", "code 1", "code 3"] });
		expect(file.cluster_theme_names).toEqual({ "0": "All" });
		expect(file.codes_per_review).toEqual([[1, ["code 0"]]]);
		expect(summary).toContain("1 clusters, 2 iteration(s)");
		expect(llm.calls[0]!.system).toContain("MEANINGFUL and INSIGHTFUL THEMES for RQ");
	});

	it("fails clearly when nothing usable comes back", async () => {
		const llm = new ScriptedLlm({ llm_clustering: "{}" });
		const deps = {
			llm,
			researchQuestion: "",
			settings: {
				maxIterations: 1,
				batchSize: 10,
				saveIterations: false,
				contextLength: 16384,
				maxCompletion: 8192,
			},
			logger: silentLogger,
		};
		await expect(clusterByLlm(["a"], [], deps)).rejects.toThrow(/no usable clusters/);
		await expect(clusterByLlm([" "], [], deps)).rejects.toThrow(/No codes/);
	});
});

describe("checkpoint files", () => {
	it("are appended per finished unit", async () => {
		const llm = new ScriptedLlm({ open_coding: "- Code: a" });
		const ctx = await makeContext({ llm, documents: [doc(1, "x"), doc(2, "y")] });
		await openCodingStage.run(ctx);
		expect((await readJsonl(ctx.paths.openCodingCheckpoint)).length).toBe(2);
	});
});
