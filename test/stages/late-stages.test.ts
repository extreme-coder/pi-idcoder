import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCooccurrence, codeMapsFromGraph } from "../../src/analysis/cooccurrence.ts";
import { buildGraphText, countLeaves, renderTreeNode, reportGraphMaxChars } from "../../src/analysis/report.ts";
import { RunPaths } from "../../src/artifacts/paths.ts";
import type { EnrichedEntry, HierarchyFile } from "../../src/artifacts/types.ts";
import { fileExists, readJson, writeJson, writeTextAtomic } from "../../src/core/fs.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { enrichCluster, fillExamplesFromMemory, renderPartials } from "../../src/enrichment/codebook.ts";
import { entryFailed, filterCodeIds, parseEntry } from "../../src/enrichment/criteria.ts";
import { clusterQuotesBlock, enrichDimension, neighbourQuotesBlock } from "../../src/enrichment/dimensions.ts";
import { SourceMemory } from "../../src/evidence/source-memory.ts";
import { buildClusterHierarchy } from "../../src/hierarchy/build.ts";
import {
	assignMissingClusters,
	mergeTwoSmallest,
	metaThemeBounds,
	normalizeMetaThemeCount,
	splitLargest,
} from "../../src/hierarchy/meta.ts";
import {
	deterministicLeaves,
	groupsForSplit,
	type RefineSettings,
	refineHierarchy,
	refineLeafBucket,
	validateSplit,
} from "../../src/hierarchy/refine.ts";
import { assembleTree, buildSubThemeNode } from "../../src/hierarchy/tree.ts";
import type { ReviewGateway } from "../../src/review/gateway.ts";
import { codebookEnrichmentStage } from "../../src/stages/codebook-enrichment.ts";
import { metaThemesStage } from "../../src/stages/meta-themes.ts";
import { reviewGateStage } from "../../src/stages/review-gate.ts";
import {
	ensureViewerScaffold,
	exportCodebookReview,
	exportProject,
	findViewerApproval,
	readManifest,
	researchQuestionFromReport,
	ViewerExportError,
} from "../../src/viewer/data.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";
import { ScriptedLlm } from "../helpers/fake-llm.ts";
import { makeContext, testConfig } from "../helpers/harness.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const refineSettings: RefineSettings = { enabled: true, maxCodesPerBucket: 48, maxDepth: 8, llmMaxCodes: 48 };
const refineDeps = (llm: ScriptedLlm, settings: Partial<RefineSettings> = {}) => ({
	llm,
	researchQuestion: "RQ",
	settings: { ...refineSettings, ...settings },
	logger: silentLogger,
});

const MD = `## Review 1

- Code: a
  Evidence: "quote a1"
  Note: note a

- Code: b
  Evidence: "quote b1"

## Review 2

- Code: a
  Evidence: "quote a2"

- Code: c
  Evidence: "quote c1"
`;

describe("hierarchy refine (ported from test_hierarchy_refine.py)", () => {
	it.each([
		[10, 48, 2],
		[100, 48, 3],
		[500, 48, 11],
		[1, 48, 2],
		[5000, 48, 12],
	])("groupsForSplit(%i, %i) = %i", (n, cap, expected) => {
		expect(groupsForSplit(n, cap)).toBe(expected);
	});

	it("validates splits as an exact multiset partition", () => {
		expect(
			validateSplit(
				["a", "b", "c"],
				[
					{ name: "G1", codes: ["a", "b"] },
					{ name: "G2", codes: ["c"] },
				],
			),
		).toHaveLength(2);
		expect(validateSplit(["a", "b"], [{ name: "G1", codes: ["a", "a"] }])).toBeUndefined();
		expect(validateSplit(["a", "b"], [{ name: "G1", codes: ["a"] }])).toBeUndefined();
		expect(validateSplit(["a"], [])).toBeUndefined();
		expect(validateSplit(["a"], "x")).toBeUndefined();
		expect(
			validateSplit(
				["a"],
				[
					{ name: " ", codes: ["a"] },
					{ name: "empty", codes: [] },
				],
			),
		).toEqual([{ name: "Unnamed", codes: ["a"] }]);
	});

	it("chunks deterministically", () => {
		const codes = Array.from({ length: 10 }, (_, i) => `c${i}`);
		const leaves = deterministicLeaves(codes, 4, "Bucket");
		expect(leaves.map((l) => l.name)).toEqual(["Bucket (part 1)", "Bucket (part 2)", "Bucket (part 3)"]);
		expect(leaves.flatMap((l) => l.codes)).toEqual(codes);
	});

	it("leaves small buckets alone without calling the LLM", async () => {
		const llm = new ScriptedLlm({});
		expect(await refineLeafBucket("C1", "Small", ["x", "y", "x"], 0, refineDeps(llm))).toEqual({
			name: "Small",
			codes: ["x", "y"],
		});
		expect(llm.calls).toHaveLength(0);
	});

	it("splits oversized buckets deterministically at the depth limit", async () => {
		const llm = new ScriptedLlm({});
		const out = await refineLeafBucket(
			"C1",
			"Big",
			Array.from({ length: 10 }, (_, i) => `code_${i}`),
			99,
			refineDeps(llm, { maxCodesPerBucket: 4 }),
		);
		expect(out.sub_themes).toHaveLength(3);
		expect(llm.calls).toHaveLength(0);
	});

	it("splits recursively with the LLM and falls back on invalid splits", async () => {
		const codes = Array.from({ length: 12 }, (_, i) => `c${i}`);
		const valid = new ScriptedLlm({
			hierarchy_refine: (req) => {
				const listed = req.prompt.match(/^- (c\d+)$/gm)!.map((l) => l.slice(2));
				const half = Math.ceil(listed.length / 2);
				return JSON.stringify({
					sub_themes: [
						{ name: `A${listed.length}`, codes: listed.slice(0, half) },
						{ name: `B${listed.length}`, codes: listed.slice(half) },
					],
				});
			},
		});
		const out = await refineLeafBucket("C", "Root", codes, 0, refineDeps(valid, { maxCodesPerBucket: 4 }));
		const flatten = (n: { codes?: string[]; sub_themes?: unknown[] }): string[] => [
			...(n.codes ?? []),
			...((n.sub_themes ?? []) as Array<{ codes?: string[]; sub_themes?: unknown[] }>).flatMap(flatten),
		];
		expect(flatten(out).sort()).toEqual([...codes].sort());
		expect(valid.calls.length).toBeGreaterThan(1);

		const invalid = new ScriptedLlm({ hierarchy_refine: '{"sub_themes": [{"name": "x", "codes": ["c0"]}]}' });
		const fallback = await refineLeafBucket("C", "Root", codes, 0, refineDeps(invalid, { maxCodesPerBucket: 4 }));
		expect(fallback.sub_themes!.map((s) => s.name)).toEqual(["Root (part 1)", "Root (part 2)", "Root (part 3)"]);
	});

	it("batches very large buckets and merges groups by name", async () => {
		const codes = Array.from({ length: 20 }, (_, i) => `c${i}`);
		const llm = new ScriptedLlm({
			hierarchy_refine: (req) => {
				const listed = req.prompt.match(/^- (c\d+)$/gm)!.map((l) => l.slice(2));
				return JSON.stringify({
					sub_themes: [
						{ name: "Even", codes: listed.filter((_, i) => i % 2 === 0) },
						{ name: "odd", codes: listed.filter((_, i) => i % 2) },
					],
				});
			},
		});
		const out = await refineLeafBucket(
			"C",
			"Root",
			codes,
			0,
			refineDeps(llm, { maxCodesPerBucket: 16, llmMaxCodes: 8 }),
		);
		expect(llm.callsFor("hierarchy_refine").length).toBe(3);
		expect(out.sub_themes!.map((s) => s.name)).toEqual(["Even", "odd"]);
	});

	it("refines a whole hierarchy with a fake LLM (fixture)", async () => {
		const llm = new ScriptedLlm({
			hierarchy_refine: JSON.stringify({
				sub_themes: [
					{ name: "Part A", codes: ["c1", "c2"] },
					{ name: "Part B", codes: ["c3"] },
				],
			}),
		});
		const out = await refineHierarchy(fixture("minimal_hierarchy.json") as HierarchyFile, refineDeps(llm));
		expect(out["1"]!.ungrouped_codes).toEqual([]);
		expect(out["1"]!.sub_themes).toEqual([{ name: "Main bucket", codes: ["c1", "c2", "c3"] }]);
	});

	it("folds ungrouped codes into named sub-themes", async () => {
		const llm = new ScriptedLlm({});
		const small = await refineHierarchy(
			{ "0": { label: "L", sub_themes: [], ungrouped_codes: ["u1", "u2"] } },
			refineDeps(llm),
		);
		expect(small["0"]!.sub_themes).toEqual([{ name: "Ungrouped codes", codes: ["u1", "u2"] }]);
		const many = Array.from({ length: 9 }, (_, i) => `u${i}`);
		const big = await refineHierarchy(
			{
				"0": {
					label: "L",
					sub_themes: [{ name: "Nested", sub_themes: [{ name: "Leaf", codes: ["x"] }], codes: ["y"] }],
					ungrouped_codes: many,
				},
			},
			refineDeps(new ScriptedLlm({ hierarchy_refine: "not json" }), { maxCodesPerBucket: 4 }),
		);
		expect(big["0"]!.sub_themes.map((s) => s.name)).toEqual([
			"Nested",
			"Further themes (L) (part 1)",
			"Further themes (L) (part 2)",
			"Further themes (L) (part 3)",
		]);
		expect(big["0"]!.sub_themes[0]).toEqual({
			name: "Nested",
			sub_themes: [
				{ name: "Leaf", codes: ["x"] },
				{ name: "Nested", codes: ["y"] },
			],
		});
	});
});

describe("meta-theme helpers (ported from test_pipeline_helpers.py)", () => {
	it.each([
		[0, [1, 1]],
		[1, [1, 1]],
		[3, [2, 3]],
		[5, [2, 5]],
		[10, [3, 7]],
	])("bounds for %i clusters", (n, expected) => {
		expect(metaThemeBounds(n)).toEqual(expected);
	});

	it("split is a no-op for a single cluster and halves otherwise", () => {
		const single = [{ name: "A", cluster_ids: ["1"] }];
		expect(splitLargest(single)).toEqual(single);
		const out = splitLargest([{ name: "Big", cluster_ids: ["a", "b", "c", "d"] }]);
		expect(out.map((m) => m.name)).toEqual(["Big", "Big (continued)"]);
		expect(out.flatMap((m) => m.cluster_ids).sort()).toEqual(["a", "b", "c", "d"]);
	});

	it("merges the two smallest groups", () => {
		const out = mergeTwoSmallest([
			{ name: "Tiny", cluster_ids: ["1"] },
			{ name: "Small", cluster_ids: ["2", "3"] },
			{ name: "Med", cluster_ids: ["4", "5", "6"] },
		]);
		expect(out.map((m) => m.name)).toEqual(["Med", "Tiny / Small"]);
		expect(mergeTwoSmallest([{ name: "One", cluster_ids: [] }])).toHaveLength(1);
	});

	it("normalizes counts into the bounds", () => {
		const four = [1, 2, 3, 4].map((i) => ({ name: `M${i}`, cluster_ids: [String(i)] }));
		expect(normalizeMetaThemeCount(four, 50)).toEqual(four);
		expect(
			normalizeMetaThemeCount([{ name: "Only", cluster_ids: ["0", "1", "2", "3", "4", "5", "6", "7"] }], 50).length,
		).toBeGreaterThanOrEqual(3);
		const nine = Array.from({ length: 9 }, (_, i) => ({ name: `M${i}`, cluster_ids: [String(i)] }));
		expect(normalizeMetaThemeCount(nine, 50)).toHaveLength(7);
		expect(normalizeMetaThemeCount([{ name: "x", cluster_ids: ["1"] }], 50)).toHaveLength(1);
	});

	it("assigns missing clusters to the largest group", () => {
		const mts = [
			{ name: "A", cluster_ids: ["0"] },
			{ name: "B", cluster_ids: ["1", "2"] },
		];
		expect(assignMissingClusters(mts, ["0", "1", "2", "3"])).toBe(1);
		expect(mts[1]!.cluster_ids).toEqual(["1", "2", "3"]);
	});
});

describe("meta-themes stage", () => {
	async function run(replies: string[]) {
		let i = 0;
		const llm = new ScriptedLlm({ meta_theme_grouping: () => replies[Math.min(i++, replies.length - 1)]! });
		const ctx = await makeContext({ llm });
		const codebook = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [String(k), `L${k}`]));
		await writeJson(ctx.paths.codebook, { codebook, cluster_to_codes: {} });
		const outcome = await metaThemesStage.run(ctx);
		return {
			llm,
			ctx,
			outcome,
			metas: (await readJson<{ meta_themes: Array<{ cluster_ids: string[] }> }>(ctx.paths.metaThemes)).meta_themes,
		};
	}

	it("retries once with a reminder when the count is out of bounds, then repairs", async () => {
		const one = JSON.stringify({ meta_themes: [{ name: "All", cluster_ids: ["0", "1", "2"] }] });
		const { llm, metas } = await run([one, one]);
		expect(llm.calls[1]!.prompt).toContain("IMPORTANT: You must output between 3 and 7");
		expect(metas.length).toBeGreaterThanOrEqual(3);
		expect(metas.flatMap((m) => m.cluster_ids).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
	});

	it("accepts an in-bounds answer without retrying", async () => {
		const good = JSON.stringify({
			meta_themes: [
				{ name: "A", cluster_ids: [0, 1, 2] },
				{ name: "B", cluster_ids: ["3", "4"] },
				{ name: "C", cluster_ids: ["5", "6", "7"] },
			],
		});
		const { llm, outcome } = await run([good]);
		expect(llm.calls).toHaveLength(1);
		expect(outcome).toMatchObject({ metrics: { meta_themes: 3 } });
	});

	it("fails on an invalid structure", async () => {
		await expect(run(['{"meta_themes": "nope"}'])).rejects.toThrow(/invalid meta_themes/);
	});
});

describe("tree assembly (ported from test_pipeline_helpers.py)", () => {
	it("builds flat and nested sub-theme nodes", () => {
		const edges: Array<{ parent: string; child: string }> = [];
		const nodes: string[] = [];
		const flat = buildSubThemeNode({ name: "Parent Theme", codes: ["c1", "c2"] }, "cluster_x", edges, nodes);
		expect(flat).toMatchObject({ type: "sub_theme", name: "Parent Theme" });
		expect(flat.children!.every((c) => c.type === "code")).toBe(true);
		expect(edges).toContainEqual({ parent: "cluster_x", child: "Parent Theme" });
		const nested = buildSubThemeNode(
			{ name: "Outer", sub_themes: [{ name: "Inner", codes: ["x"] }], codes: [] },
			"cl",
			[],
			[],
		);
		expect(nested.children![0]).toEqual({
			name: "Inner",
			type: "sub_theme",
			children: [{ name: "x", type: "code" }],
		});
	});

	it("assembles meta-themes, themes, sub-themes, and ungrouped codes", () => {
		const graph = assembleTree(
			"",
			[{ name: "Meta", cluster_ids: ["0", "1"] }],
			{ "0": { label: "Lag", sub_themes: [{ name: "Net", codes: ["ping"] }], ungrouped_codes: ["stutter"] } },
			{ "1": "Price" },
		);
		expect(graph.tree.name).toBe("Thematic Analysis");
		expect(graph.tree.children![0]!.children!.map((c) => c.name)).toEqual(["Lag", "Price"]);
		expect(graph.edges).toContainEqual({ parent: "Lag", child: "stutter" });
		expect(graph.canonical_nodes).toEqual([...graph.canonical_nodes].sort());
		expect(graph.merge_groups).toEqual([]);
	});
});

describe("report graph text (ported from test_report.py)", () => {
	it("renders code leaves and counts leaves", () => {
		expect(renderTreeNode({ name: "laggy UI", type: "code" })).toContain("* laggy UI");
		expect(
			countLeaves({
				name: "Root",
				type: "theme",
				children: [
					{ name: "a", type: "code" },
					{ name: "sub", type: "sub_theme", children: [{ name: "b", type: "code" }] },
				],
			}),
		).toBe(2);
	});

	it("renders the tree format", () => {
		const { text, truncated } = buildGraphText(fixture("minimal_global_graph.json"), 50_000);
		expect(text).toContain("THEME HIERARCHY");
		expect(text).toContain("ThemeA");
		expect(text).toContain("code_a");
		expect(truncated).toBe(false);
		expect(buildGraphText(fixture("minimal_global_graph.json"), 100).text).toContain("[hierarchy truncated");
	});

	it("truncates the legacy format", () => {
		const graph = {
			canonical_nodes: Array.from({ length: 20 }, (_, i) => `node_${i}`),
			edges: Array.from({ length: 20 }, (_, i) => ({ parent: `p${i}`, child: `c${i}` })),
		};
		const { text, truncated } = buildGraphText(graph, 400);
		expect(truncated).toBe(true);
		expect(text.toLowerCase()).toContain("truncated");
		expect(buildGraphText({}, 4000).text).toContain("(none listed)");
	});

	it("budgets the graph like the original (8k context)", () => {
		expect(reportGraphMaxChars(8000)).toBe(14100);
		expect(reportGraphMaxChars(1024)).toBe(4000);
	});
});

describe("co-occurrence (ported from test_cooccurrence.py)", () => {
	it("maps codes to theme and meta-theme", () => {
		const { theme, meta } = codeMapsFromGraph(fixture("minimal_global_graph.json"));
		expect(theme.get("code_a")).toBe("ThemeA");
		expect(theme.get("code_b")).toBe("ThemeB");
		expect(meta.get("code_a")).toBe("MetaOne");
		expect(() => codeMapsFromGraph({})).toThrow(/tree/);
	});

	it("counts theme pairs within reviews", () => {
		const { data } = buildCooccurrence(
			fixture("minimal_clustered_codes.json").codes_per_review,
			fixture("minimal_global_graph.json"),
		);
		expect(data.theme_matrix.ThemeA!.ThemeB).toBe(1);
		expect(data.theme_matrix.ThemeB!.ThemeA).toBe(1);
		expect(data.total_reviews).toBe(1);
		expect(data.top_theme_pairs[0]).toEqual({ pair: ["ThemeA", "ThemeB"], count: 1, pct_reviews: 1 });
		expect(data.review_coverage.meta_themes.MetaOne).toEqual({ count: 1, pct: 1 });
	});

	it("skips unmapped codes", () => {
		const { data, skippedCodes } = buildCooccurrence(
			[["review-1", ["code_a", "unknown"]], "junk", [3]],
			fixture("minimal_global_graph.json"),
		);
		expect(data.theme_matrix).toEqual({});
		expect(skippedCodes).toBe(1);
		expect(data.total_reviews).toBe(3);
	});
});

describe("codebook enrichment", () => {
	const memory = SourceMemory.build(MD);
	const evidence = memory.evidenceByCode();
	const settings = testConfig().enrichment;
	const entry = (ids: string[][]) =>
		JSON.stringify({
			label: "x",
			definition: "d",
			keywords: ["k"],
			inclusion: ids.map((code_ids) => ({ criterion: "c", code_ids })),
			exclusion: [{ criterion: "e", code_ids: ["LC002"] }],
		});

	it("parses entries and filters invalid ids", () => {
		expect(() => parseEntry('{"label": "x"}', "x")).toThrow(/missing keys/);
		const parsed = parseEntry(entry([["LC001", "LC009"], ["LC010"]]), "Label");
		const { bad, dropped } = filterCodeIds(parsed, new Set(["LC001", "LC002"]));
		expect([...bad].sort()).toEqual(["LC009", "LC010"]);
		expect(dropped).toBe(1);
		expect(parsed.label).toBe("Label");
		expect(parsed.inclusion).toEqual([{ criterion: "c", code_ids: ["LC001"] }]);
		expect(entryFailed({ label: "x", definition: "", keywords: [], inclusion: [], exclusion: [] })).toBe(true);
	});

	it("retries once with a correction when the model invents ids", async () => {
		let call = 0;
		const llm = new ScriptedLlm({
			codebook_enrichment: () => (++call === 1 ? entry([["LC009"]]) : entry([["LC001"]])),
		});
		const result = await enrichCluster("0", "Theme", ["a", "b"], {
			llm,
			memory,
			evidence,
			settings,
			logger: silentLogger,
		});
		expect(llm.calls[1]!.prompt).toContain("CORRECTION: your previous response used non-existent IDs: LC009");
		expect(llm.calls[0]!.jsonSchema!.name).toBe("codebook_entry");
		expect(result.inclusion[0]!.examples).toEqual([expect.objectContaining({ quote: "quote a1", review_id: 1 })]);
		expect(llm.calls[0]!.prompt).toContain(
			'- [LC001] a\n  [QUOTE] "quote a1"\n  [QUOTE] "quote a2"\n  [NOTE] note a',
		);
	});

	it("uses batched summaries for large clusters", async () => {
		const codes = Array.from({ length: 30 }, (_, i) => (i === 0 ? "a" : `code ${i}`));
		const llm = new ScriptedLlm({
			codebook_batch_enrich:
				'{"definition_notes": "notes", "inclusion": [{"criterion": "x", "code_ids": ["LC001"]}], "exclusion": []}',
			codebook_enrichment: entry([["LC001"]]),
		});
		const result = await enrichCluster("0", "Theme", codes, {
			llm,
			memory,
			evidence,
			settings,
			logger: silentLogger,
		});
		expect(llm.callsFor("codebook_batch_enrich")).toHaveLength(2);
		const synthesis = llm.callsFor("codebook_enrichment")[0]!.prompt;
		expect(synthesis).toContain("[Batch 1/2]");
		expect(synthesis).toContain("All 30 open codes in this cluster");
		expect(result.inclusion).toHaveLength(1);
	});

	it("returns an empty entry when the model fails", async () => {
		const llm = new ScriptedLlm({ codebook_enrichment: new Error("down") });
		expect(
			entryFailed(await enrichCluster("0", "T", ["a"], { llm, memory, evidence, settings, logger: silentLogger })),
		).toBe(true);
	});

	it("fills at most three distinct examples and drops criteria without evidence", () => {
		const e: EnrichedEntry = {
			label: "T",
			definition: "d",
			keywords: [],
			inclusion: [{ criterion: "c", code_ids: ["LC001", "LC001", "LC002", "LC003", "LC001"] }],
			exclusion: [{ criterion: "unknown", code_ids: ["LC009"] }],
		};
		fillExamplesFromMemory(
			e,
			new Map([
				["LC001", "a"],
				["LC002", "b"],
				["LC003", "c"],
			]),
			memory,
		);
		expect(e.inclusion[0]!.examples!.map((x) => (x as { quote: string }).quote)).toEqual([
			"quote a1",
			"quote a2",
			"quote b1",
		]);
		expect(e.exclusion).toEqual([]);
	});

	it("renders batch partials", () => {
		expect(
			renderPartials([
				{ definition_notes: "n", inclusion: [{ criterion: "i", code_ids: ["LC001"] }], exclusion: [] },
			]),
		).toBe("\n[Batch 1/1]\nDefinition notes: n\nInclusion criteria:\n  - i (codes: LC001)\n");
	});

	it("stage fails listing empty clusters but checkpoints the successful ones", async () => {
		const llm = new ScriptedLlm({
			codebook_enrichment: (req) => (req.prompt.includes("Theme: Bad") ? "garbage" : entry([["LC001"]])),
		});
		const ctx = await makeContext({ llm });
		await writeTextAtomic(ctx.paths.openCodesMarkdown, MD);
		await writeJson(ctx.paths.codebook, {
			codebook: { "0": "Good", "1": "Bad" },
			cluster_to_codes: { "0": ["a", "b"], "1": ["c"] },
		});
		await expect(codebookEnrichmentStage.run(ctx)).rejects.toThrow(/1 cluster\(s\) failed enrichment.*1:Bad/);
		const fixedLlm = new ScriptedLlm({ codebook_enrichment: entry([["LC001"]]) });
		const ctx2 = await makeContext({ llm: fixedLlm, projectDir: ctx.projectDir });
		await codebookEnrichmentStage.run(ctx2);
		expect(fixedLlm.calls.length).toBeGreaterThan(0);
		expect(fixedLlm.calls.every((c) => c.prompt.includes("Theme: Bad"))).toBe(true);
		const cb = await readJson<{ codebook_enriched: Record<string, EnrichedEntry>; enriched_schema_version: number }>(
			ctx.paths.codebook,
		);
		expect(Object.keys(cb.codebook_enriched)).toEqual(["0", "1"]);
		expect(cb.enriched_schema_version).toBe(1);
		expect(await fileExists(ctx.paths.codeIdMap)).toBe(true);
	});
});

describe("dimension enrichment", () => {
	const memory = SourceMemory.build(MD);
	const { quotes } = memory.evidenceByCode();
	const ctc = { "0": ["a"], "1": ["b"], "2": ["c"] };

	it("builds capped and full quote blocks", () => {
		expect(clusterQuotesBlock(["0"], ctc, quotes, 1)).toBe('- [CL00]\n  [QUOTE] "quote a1"');
		expect(clusterQuotesBlock(["0"], ctc, quotes, undefined)).toBe(
			'- [CL00]\n  [QUOTE] "quote a1"\n  [QUOTE] "quote a2"',
		);
		expect(neighbourQuotesBlock(["0"], { ...ctc, "3": ["none"] }, quotes)).toBe(
			'- [CL01]\n  [QUOTE] "quote b1"\n- [CL02]\n  [QUOTE] "quote c1"',
		);
	});

	it("constrains inclusion to own clusters and exclusion to all clusters", async () => {
		const llm = new ScriptedLlm({
			dimension_enrichment: JSON.stringify({
				label: "x",
				definition: "d",
				keywords: [],
				inclusion: [
					{ criterion: "own", code_ids: ["CL00"] },
					{ criterion: "foreign", code_ids: ["CL02"] },
				],
				exclusion: [{ criterion: "other", code_ids: ["CL02"] }],
			}),
		});
		const settings = { ...testConfig().enrichment, dimensionEvidence: "full" as const };
		const entry = await enrichDimension("Dim", ["0", "1"], {
			llm,
			memory,
			quotes,
			clusterToCodes: ctc,
			settings,
			logger: silentLogger,
		});
		expect(entry.inclusion.map((c) => c.criterion)).toEqual(["own"]);
		expect(entry.exclusion[0]!.examples).toEqual([expect.objectContaining({ quote: "quote c1" })]);
		expect(llm.calls).toHaveLength(2);
		expect(llm.calls[0]!.prompt).toContain("ALL quotes from OTHER (neighboring) clusters");
		const schema = llm.calls[0]!.jsonSchema!.schema as {
			properties: Record<string, { items: { properties: { code_ids: { items: { enum: string[] } } } } }>;
		};
		expect(schema.properties.inclusion!.items.properties.code_ids.items.enum).toEqual(["CL00", "CL01"]);
		expect(schema.properties.exclusion!.items.properties.code_ids.items.enum).toEqual(["CL00", "CL01", "CL02"]);
	});
});

describe("hierarchy construction", () => {
	const deps = (llm: ScriptedLlm, overrides: Partial<ReturnType<typeof testConfig>["hierarchy"]> = {}) => ({
		llm,
		embedder: new HashingEmbedder(),
		researchQuestion: "RQ",
		settings: { ...testConfig().hierarchy, ...overrides },
		logger: silentLogger,
	});

	it("keeps clusters of five or fewer codes flat", async () => {
		const llm = new ScriptedLlm({});
		expect(await buildClusterHierarchy("0", "L", ["a", "b", "a"], deps(llm))).toEqual({
			label: "L",
			sub_themes: [],
			ungrouped_codes: ["a", "b"],
		});
	});

	it("groups the first batch, assigns overflow, and keeps leftovers ungrouped", async () => {
		const codes = Array.from({ length: 9 }, (_, i) => `c${i}`);
		const llm = new ScriptedLlm({
			hierarchy_construction: (req) =>
				req.prompt.includes("Existing sub-themes")
					? JSON.stringify({ assignments: { S1: ["c7", "zzz"], Ghost: ["c8"] }, unassigned: [] })
					: JSON.stringify({
							sub_themes: [
								{ name: "S1", codes: ["c0", "c1", "invented"] },
								{ name: "Empty", codes: [] },
							],
							ungrouped_codes: ["c2"],
						}),
		});
		const entry = await buildClusterHierarchy("0", "L", codes, deps(llm, { firstBatchSize: 6, assignBatch: 20 }));
		expect(entry.sub_themes).toEqual([{ name: "S1", codes: ["c0", "c1", "c7"] }]);
		expect(entry.ungrouped_codes).toEqual(["c2", "c3", "c4", "c5", "c6", "c8"]);
	});

	it("drains ungrouped codes to the nearest sub-theme when enabled", async () => {
		const codes = ["crash a", "crash b", "lag a", "lag b", "crash c", "lag c"];
		const llm = new ScriptedLlm({
			hierarchy_construction: JSON.stringify({
				sub_themes: [
					{ name: "crash", codes: ["crash a"] },
					{ name: "lag", codes: ["lag a"] },
				],
				ungrouped_codes: [],
			}),
		});
		const entry = await buildClusterHierarchy("0", "L", codes, deps(llm, { embedDrain: true, drainThreshold: 0 }));
		expect(entry.ungrouped_codes).toEqual([]);
		expect(entry.sub_themes.find((s) => s.name === "crash")!.codes).toEqual(["crash a", "crash b", "crash c"]);
	});

	it("falls back to all-ungrouped when the model fails", async () => {
		const llm = new ScriptedLlm({ hierarchy_construction: new Error("x") });
		const codes = Array.from({ length: 7 }, (_, i) => `c${i}`);
		expect((await buildClusterHierarchy("0", "L", codes, deps(llm))).ungrouped_codes).toEqual(codes);
	});
});

describe("review gate stage", () => {
	async function prepared(review?: ReviewGateway) {
		const llm = new ScriptedLlm({});
		const ctx = await makeContext({ llm, ...(review ? { review } : {}) });
		await writeTextAtomic(ctx.paths.openCodesMarkdown, MD);
		const ctc = { "0": ["a", "b"], "1": ["c"] };
		await writeJson(ctx.paths.clusteredCodes, {
			all_codes: ["a", "b", "c"],
			labels: [0, 0, 1],
			k: 2,
			cluster_to_codes: ctc,
		});
		await writeJson(ctx.paths.codebook, { codebook: { "0": "A", "1": "C" }, cluster_to_codes: ctc });
		await writeJson(ctx.paths.codebookConfidence, { "0": { label: "A", confidence: 2, rationale: "why" } });
		return ctx;
	}

	it("pauses with a viewer-ready proposal when nobody has approved yet", async () => {
		const ctx = await prepared();
		const outcome = await reviewGateStage.run(ctx);
		expect(outcome.status).toBe("paused");
		const v1 = await readJson<{ clusters: Record<string, { description: string }> }>(ctx.paths.codebookV1);
		expect(v1.clusters["0"]!.description).toBe("why");
		const evidence = await readJson<{ by_open_code: Record<string, { quote_count: number }> }>(
			join(ctx.projectDir, ".idcoder/viewer-data/codebook-reviews/test/code_evidence.json"),
		);
		expect(evidence.by_open_code.a!.quote_count).toBe(2);
	});

	it("materializes an approval returned by the gateway", async () => {
		const ctx = await prepared({
			review: async (req) => ({
				kind: "approved",
				payload: {
					...req.proposal,
					clusters: { ...req.proposal.clusters, "1": { ...req.proposal.clusters["1"], status: "drop" } },
				},
				reviewId: "rev-1",
				approvedAt: "2026-01-01T00:00:00Z",
			}),
		});
		const outcome = await reviewGateStage.run(ctx);
		expect(outcome).toMatchObject({ status: "done", metrics: { clusters: 1, orphaned: 1 } });
		expect(await readJson(ctx.paths.codebook)).toEqual({
			codebook: { "0": "A" },
			cluster_to_codes: { "0": ["a", "b"] },
		});
		expect(await readJson(ctx.paths.codebookProvenance)).toMatchObject({
			review_id: "rev-1",
			approved_at: "2026-01-01T00:00:00Z",
			orphaned_codes: ["c"],
		});
		expect(await fileExists(ctx.paths.codebookV2)).toBe(true);
		expect((await reviewGateStage.run(ctx)).summary).toContain("already approved");
	});

	it("picks up an approval saved by the browser viewer", async () => {
		const ctx = await prepared();
		const v2 = {
			version: 2,
			clusters: { "0": { label: "Renamed" }, "1": { label: "C" } },
			operations: [],
			cluster_to_codes: { "0": ["a", "b"], "1": ["c"] },
		};
		await writeJson(join(ctx.projectDir, ".idcoder/viewer-data/codebook-reviews/test/test-codebook_v2.json"), v2);
		expect((await reviewGateStage.run(ctx)).status).toBe("done");
		expect((await readJson<{ codebook: Record<string, string> }>(ctx.paths.codebook)).codebook["0"]).toBe("Renamed");
	});

	it("is disabled by config", () => {
		expect(reviewGateStage.enabled(testConfig({ review: { enabled: false } }))).toBe(false);
	});
});

describe("viewer data (ported from test_viewer_export.py)", () => {
	async function outputs() {
		const root = await mkdtemp(join(tmpdir(), "idc-viewer-"));
		const paths = new RunPaths(join(root, "run"));
		await writeJson(paths.codebook, { codebook: { "1": "Theme A" }, cluster_to_codes: { "1": ["c1"] } });
		await writeJson(paths.clusteredCodes, { cluster_to_codes: { "1": ["c1"] } });
		await writeJson(paths.codebookConfidence, {});
		await writeJson(paths.globalGraph, { tree: { name: "What themes emerge?", type: "root", children: [] } });
		await writeTextAtomic(paths.researchReport, "## Research question\n\nWhat themes emerge?\n");
		await writeTextAtomic(
			paths.openCodesMarkdown,
			'## Review 1\n\n- Code: c1\n  Evidence: "example quote one"\n  Note: first note\n',
		);
		return { viewer: join(root, "viewer-data"), paths };
	}

	it("creates an empty manifest", async () => {
		const { viewer } = await outputs();
		await ensureViewerScaffold(viewer);
		expect(await readManifest(viewer)).toEqual({ projects: [], codebook_reviews: [] });
	});

	it("exports a codebook review and updates the manifest", async () => {
		const { viewer, paths } = await outputs();
		const dir = await exportCodebookReview({ root: viewer, slug: "my-study", researchQuestion: "RQ?", paths });
		expect(await fileExists(join(dir, "codebook.json"))).toBe(true);
		expect(await fileExists(join(dir, "gt_clustered_codes.json"))).toBe(true);
		expect((await readManifest(viewer)).codebook_reviews).toEqual(["my-study"]);
		await exportCodebookReview({ root: viewer, slug: "my-study", researchQuestion: "RQ?", paths });
		expect((await readManifest(viewer)).codebook_reviews).toEqual(["my-study"]);
	});

	it("exports a project and resolves the research question from the report", async () => {
		const { viewer, paths } = await outputs();
		const dir = await exportProject({ root: viewer, slug: "my-study", researchQuestion: "", paths });
		expect(await fileExists(join(dir, "gt_global_graph.json"))).toBe(true);
		expect((await readJson<{ research_question: string }>(join(dir, "meta.json"))).research_question).toBe(
			"What themes emerge?",
		);
		expect((await readManifest(viewer)).projects).toEqual(["my-study"]);
	});

	it("requires the graph and report", async () => {
		const root = await mkdtemp(join(tmpdir(), "idc-viewer-"));
		await expect(
			exportProject({ root, slug: "s", researchQuestion: "", paths: new RunPaths(join(root, "run")) }),
		).rejects.toThrow(ViewerExportError);
		await expect(
			exportCodebookReview({ root, slug: "s", researchQuestion: "", paths: new RunPaths(join(root, "run")) }),
		).rejects.toThrow(/codebook/);
	});

	it("parses the report's research question and finds approvals", async () => {
		expect(researchQuestionFromReport('## Research question\n\n"Quoted?"\n')).toBe("Quoted?");
		expect(researchQuestionFromReport("no marker")).toBe("");
		const { viewer } = await outputs();
		expect(await findViewerApproval(viewer, "none")).toBeUndefined();
	});
});
