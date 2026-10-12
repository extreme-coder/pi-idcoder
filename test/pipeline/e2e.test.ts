import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	ClusteredCodesFile,
	CodebookFile,
	CodebookProvenanceFile,
	DimensionsEnrichedFile,
	GlobalGraphFile,
	HierarchyFile,
	MetaThemesFile,
} from "../../src/artifacts/types.ts";
import { fileExists, readJson, readJsonl, writeJson } from "../../src/core/fs.ts";
import type { RunEvent } from "../../src/pipeline/runner.ts";
import { RunSession } from "../../src/pipeline/session.ts";
import { STAGE_IDS } from "../../src/pipeline/stage.ts";
import type { RunState } from "../../src/pipeline/state.ts";
import { pausingReviewGateway } from "../../src/review/gateway.ts";
import type { EnrichedCodebook } from "../../src/review/schema.ts";
import { ReviewSession } from "../../src/review/session.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";
import { tempProject, testConfig, writeCorpus } from "../helpers/harness.ts";
import { gameReviews, SimulatedGateway } from "../helpers/simulated-llm.ts";

async function setup(configOverrides: Parameters<typeof testConfig>[0] = {}) {
	const projectDir = await tempProject();
	await writeCorpus(projectDir, gameReviews());
	const config = testConfig({
		clustering: { kMin: 2, kMaxCap: 8 },
		labeling: { samples: 3, sampleSize: 4 },
		...configOverrides,
	});
	const gateway = new SimulatedGateway();
	const session = new RunSession({ projectDir, config, gateway, embedder: new HashingEmbedder(), retryBaseMs: 0 });
	return { projectDir, config, gateway, session };
}

async function approveWithEdits(session: RunSession): Promise<EnrichedCodebook> {
	const proposal = await readJson<EnrichedCodebook>(session.paths.codebookV1);
	const review = new ReviewSession(proposal);
	const [first] = review.list();
	review.rename(first!.id, "Renamed by researcher");
	review.toggleNeedsEvidence(first!.id);
	const payload = review.toPayload();
	await writeJson(session.paths.codebookV2, payload);
	return payload;
}

describe("full inductive pipeline (simulated model)", () => {
	it("pauses at the review gate, then resumes to a complete, viewer-ready run", async () => {
		const { session, gateway } = await setup();
		const events: RunEvent[] = [];

		const first = await session.run({ review: pausingReviewGateway, onEvent: (e) => events.push(e) });
		expect(first.status).toBe("paused");
		expect(first.status === "paused" && first.stage).toBe("codebook_review");
		expect(first.status === "paused" && first.message).toContain("/idcoder review");

		const markdown = await readFile(session.paths.openCodesMarkdown, "utf8");
		expect(markdown.match(/^## Review \d+$/gm)).toHaveLength(32);
		expect(markdown).toContain("Applicability: NONE");
		const viewerReview = join(session.projectDir, ".idcoder/viewer-data/codebook-reviews/test");
		for (const f of ["codebook.json", "gt_clustered_codes.json", "code_evidence.json", "meta.json"]) {
			expect(await fileExists(join(viewerReview, f))).toBe(true);
		}
		expect(await readJson(join(session.projectDir, ".idcoder/viewer-data/manifest.json"))).toEqual({
			projects: [],
			codebook_reviews: ["test"],
		});
		expect(events.some((e) => e.type === "stage_progress" && e.stage === "open_coding")).toBe(true);

		await approveWithEdits(session);
		const callsBefore = gateway.calls.length;
		const second = await session.run({ review: pausingReviewGateway });
		expect(second.status).toBe("completed");
		expect(gateway.calls.slice(0, callsBefore).every((c) => c.skill !== "")).toBe(true);
		expect(gateway.calls.slice(callsBefore).some((c) => c.skill === "open_coding")).toBe(false);

		const state = await readJson<RunState>(session.paths.state);
		for (const id of STAGE_IDS) expect(state.stages[id].status, id).toBe("done");

		const provenance = await readJson<CodebookProvenanceFile>(session.paths.codebookProvenance);
		const renamed = provenance.entries.find((e) => e.label === "Renamed by researcher")!;
		expect(renamed.source).toBe("llm+edited");
		expect(provenance.skip_refine_cluster_ids).toEqual([renamed.cluster_id]);

		const codebook = await readJson<CodebookFile>(session.paths.codebook);
		expect(Object.keys(codebook.codebook_enriched ?? {})).toEqual(Object.keys(codebook.codebook));
		for (const entry of Object.values(codebook.codebook_enriched!)) {
			expect(entry.definition).not.toBe("");
			for (const criterion of [...entry.inclusion, ...entry.exclusion]) {
				expect(criterion.examples!.length).toBeGreaterThan(0);
				for (const example of criterion.examples!) expect(example).toHaveProperty("snippet_id");
			}
		}

		const hierarchy = await readJson<HierarchyFile>(session.paths.hierarchy);
		expect(Object.keys(hierarchy).sort()).toEqual(Object.keys(codebook.codebook).sort());
		const metas = await readJson<MetaThemesFile>(session.paths.metaThemes);
		expect(metas.meta_themes.flatMap((m) => m.cluster_ids).sort()).toEqual(Object.keys(codebook.codebook).sort());
		const dims = await readJson<DimensionsEnrichedFile>(session.paths.metaThemesEnriched);
		expect(dims.meta_themes_enriched).toHaveLength(metas.meta_themes.length);

		const graph = await readJson<GlobalGraphFile>(session.paths.globalGraph);
		expect(graph.tree.name).toBe("What frustrates players?");
		const clustered = await readJson<ClusteredCodesFile>(session.paths.clusteredCodes);
		const leaves = new Set(graph.edges.map((e) => e.child));
		for (const code of Object.values(clustered.cluster_to_codes).flat()) expect(leaves.has(code)).toBe(true);

		expect(await readFile(session.paths.researchReport, "utf8")).toContain("## Research answer");
		expect(await fileExists(session.paths.cooccurrence)).toBe(true);
		for (const f of ["gt_global_graph.json", "research_report.md", "cooccurrence.json", "meta.json"]) {
			expect(await fileExists(join(session.projectDir, ".idcoder/viewer-data/projects/test", f))).toBe(true);
		}

		const usage = await readJsonl<{ stage: string }>(session.paths.usage);
		expect(usage).toHaveLength(gateway.calls.length);
		expect(new Set(usage.map((u) => u.stage))).toContain("open_coding");
		expect(await readFile(session.paths.trace, "utf8")).toContain("=== STAGE_START ===");

		const third = await session.run({ review: pausingReviewGateway });
		expect(third.status).toBe("completed");
		expect(gateway.calls).toHaveLength(usage.length);
	});

	it("re-runs a stage and everything after it on request", async () => {
		const { session, gateway } = await setup({ review: { enabled: false } });
		expect((await session.run({ review: pausingReviewGateway })).status).toBe("completed");
		const before = gateway.calls.length;
		const result = await session.run({ review: pausingReviewGateway, from: "meta_themes" });
		expect(result.status).toBe("completed");
		const rerun = new Set(gateway.calls.slice(before).map((c) => c.skill));
		expect(rerun.has("meta_theme_grouping")).toBe(true);
		expect(rerun.has("open_coding")).toBe(false);
		expect(rerun.has("hierarchy_construction")).toBe(false);
		const state = await readJson<RunState>(session.paths.state);
		expect(state.stages.codebook_review.status).toBe("skipped");
	});

	it("stops after `until`", async () => {
		const { session } = await setup();
		const result = await session.run({ review: pausingReviewGateway, until: "axial_clustering" });
		expect(result.status).toBe("completed");
		const state = await readJson<RunState>(session.paths.state);
		expect(state.stages.axial_clustering.status).toBe("done");
		expect(state.stages.cluster_labeling.status).toBe("pending");
	});

	it("records a failed stage and resumes from it with checkpoints intact", async () => {
		const projectDir = await tempProject();
		await writeCorpus(projectDir, gameReviews());
		const config = testConfig({ review: { enabled: false }, clustering: { kMin: 2, kMaxCap: 8 } });
		let failMeta = true;
		const flaky = new SimulatedGateway((_ref, _skill, request) => {
			if (failMeta && request.prompt.includes("You are organising the results")) return "not json at all";
			return undefined;
		});
		const session = new RunSession({
			projectDir,
			config,
			gateway: flaky,
			embedder: new HashingEmbedder(),
			retryBaseMs: 0,
		});
		const failed = await session.run({ review: pausingReviewGateway });
		expect(failed.status).toBe("failed");
		expect(failed.status === "failed" && failed.stage).toBe("meta_themes");
		const state = await readJson<RunState>(session.paths.state);
		expect(state.stages.meta_themes).toMatchObject({ status: "failed" });
		expect(state.stages.hierarchy.status).toBe("done");

		failMeta = false;
		const before = flaky.calls.length;
		expect((await session.run({ review: pausingReviewGateway })).status).toBe("completed");
		expect(flaky.calls.slice(before).some((c) => c.skill === "hierarchy_construction")).toBe(false);
	});

	it("aborts cleanly and resumes open coding from its checkpoint", async () => {
		const { session, gateway } = await setup({ openCoding: { workers: 1 } });
		const controller = new AbortController();
		const result = await session.run({
			review: pausingReviewGateway,
			signal: controller.signal,
			onEvent: (e) => {
				if (e.type === "stage_progress" && e.stage === "open_coding" && e.progress.done === 5) controller.abort();
			},
		});
		expect(result.status).toBe("aborted");
		const coded = gateway.calls.filter((c) => c.skill === "open_coding").length;
		expect(coded).toBeLessThan(32);
		const state = await readJson<RunState>(session.paths.state);
		expect(state.stages.open_coding.status).toBe("pending");

		await session.run({ review: pausingReviewGateway, until: "open_coding" });
		expect(gateway.calls.filter((c) => c.skill === "open_coding").length).toBe(32);
	});

	it("runs with HICode-style LLM clustering", async () => {
		const { session, gateway } = await setup({ review: { enabled: false }, clustering: { method: "llm" } });
		expect((await session.run({ review: pausingReviewGateway })).status).toBe("completed");
		const clustered = await readJson<ClusteredCodesFile>(session.paths.clusteredCodes);
		expect(clustered.clustering_method).toBe("llm");
		expect(Object.values(clustered.cluster_theme_names ?? {})).toEqual(
			expect.arrayContaining(["Crash issues", "Lag issues", "Price issues", "Story issues"]),
		);
		expect(gateway.calls.some((c) => c.skill === "high_level_code_generation")).toBe(false);
		expect(await fileExists(join(session.paths.llmClusteringDir, "cluster_iter_0.json"))).toBe(true);
	});

	it("validates model references before doing any work", async () => {
		const { session, gateway } = await setup({ models: { coder: "missing/model" } });
		const strict = new RunSession({
			projectDir: session.projectDir,
			config: session.config,
			gateway: {
				describe: (ref) => {
					throw new Error(`Unknown model "${ref}"`);
				},
				complete: gateway.complete.bind(gateway),
			},
			embedder: new HashingEmbedder(),
		});
		await expect(strict.run({ review: pausingReviewGateway })).rejects.toThrow(/Unknown model/);
		expect(gateway.calls).toHaveLength(0);
	});
});
