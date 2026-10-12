import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunPaths } from "../../src/artifacts/paths.ts";
import type { ClusteredCodesFile } from "../../src/artifacts/types.ts";
import { writeJson } from "../../src/core/fs.ts";
import { applyCodebookReview, CodebookReviewError, materializeClustered } from "../../src/review/apply.ts";
import { FileWaitReviewGateway, findSavedApproval, pausingReviewGateway } from "../../src/review/gateway.ts";
import { buildV1, type EnrichedCodebook, flatCodebook } from "../../src/review/schema.ts";
import { ReviewSession } from "../../src/review/session.ts";

const baseClustered = (): ClusteredCodesFile => ({
	all_codes: ["a", "b", "c", "d"],
	labels: [0, 0, 1, 1],
	k: 2,
	cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
	codes_per_review: [
		[1, ["a", "b"]],
		[2, ["c", "d"]],
	],
});

describe("applyCodebookReview (ported from test_codebook_edits.py)", () => {
	it("rename only updates labels and provenance", () => {
		const v2: EnrichedCodebook = {
			version: 1,
			clusters: {
				"0": {
					label: "Renamed theme",
					description: "updated rationale",
					confidence: 4,
					source: "llm+edited",
					status: "keep",
				},
				"1": { label: "Cluster 1", description: "", confidence: 3, source: "llm", status: "keep" },
			},
			operations: [],
			cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
		};
		const result = applyCodebookReview(v2, baseClustered(), { reviewId: "r1" });
		expect(result.codebook["0"]).toBe("Renamed theme");
		expect(result.provenance.entries[0]!.source).toBe("llm+edited");
		expect(result.confidence["0"]!.rationale).toBe("updated rationale");
		expect(result.provenance.review_id).toBe("r1");
	});

	it("merge combines codes", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: { "0": { label: "Merged", source: "human" }, "1": { label: "Merged", source: "human" } },
				operations: [{ type: "merge", from_cluster_ids: ["0", "1"], target_cluster_id: "0", label: "Merged" }],
				cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		expect(Object.keys(result.clusterToCodes)).toHaveLength(1);
		expect(new Set(result.clusterToCodes["0"])).toEqual(new Set(["a", "b", "c", "d"]));
	});

	it("split partitions codes", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: { "0a": { label: "Part A" }, "0b": { label: "Part B" }, "1": { label: "Other" } },
				operations: [
					{
						type: "split",
						from_cluster_id: "0",
						splits: [
							{ new_cluster_id: "0a", label: "Part A", code_ids: ["a"] },
							{ new_cluster_id: "0b", label: "Part B", code_ids: ["b"] },
						],
					},
				],
				cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		expect(Object.values(result.clusterToCodes)).toEqual(expect.arrayContaining([["a"], ["b"]]));
		expect(Object.keys(result.clusterToCodes)).toHaveLength(3);
	});

	it("drop orphans codes", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: { "0": { label: "Keep" }, "1": { label: "Gone", status: "drop" } },
				operations: [{ type: "drop", cluster_id: "1", code_disposition: "orphan" }],
				cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		expect(Object.keys(result.clusterToCodes)).toHaveLength(1);
		expect(result.orphanedCodes).toEqual(["c", "d"]);
	});

	it("needs_more_evidence marks clusters to skip during refinement", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: { "0": { label: "Uncertain", needs_more_evidence: true }, "1": { label: "Clear" } },
				operations: [],
				cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		expect(result.skipRefineClusterIds.has("0")).toBe(true);
		expect(result.provenance.skip_refine_cluster_ids).toEqual(["0"]);
	});

	it("does not replay a split that the viewer export already reflects", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: { "2a": { label: "Part A" }, "2b": { label: "Part B" }, "1": { label: "Other" } },
				operations: [
					{
						type: "split",
						from_cluster_id: "0",
						splits: [
							{ new_cluster_id: "2a", code_ids: ["a"] },
							{ new_cluster_id: "2b", code_ids: ["b"] },
						],
					},
				],
				cluster_to_codes: { "2a": ["a"], "2b": ["b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		expect(Object.values(result.clusterToCodes).map((v) => new Set(v))).toEqual(
			expect.arrayContaining([new Set(["a"]), new Set(["b"]), new Set(["c", "d"])]),
		);
	});

	it("does not replay chained operations whose sources are gone (merge into 0, then split 0)", () => {
		const result = applyCodebookReview(
			{
				version: 2,
				clusters: { "3": { label: "Rest" }, "4": { label: "Split off" } },
				operations: [
					{ type: "merge", from_cluster_ids: ["0", "1"], target_cluster_id: "0" },
					{
						type: "split",
						from_cluster_id: "0",
						splits: [
							{ new_cluster_id: "3", code_ids: ["a", "b", "c"] },
							{ new_cluster_id: "4", code_ids: ["d"] },
						],
					},
				],
				cluster_to_codes: { "3": ["a", "b", "c"], "4": ["d"] },
			},
			baseClustered(),
		);
		expect(result.clusterToCodes).toEqual({ "0": ["a", "b", "c"], "1": ["d"] });
	});

	it("still replays a merge whose sources are present", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: {},
				operations: [{ type: "merge", from_cluster_ids: ["0", "1"], target_cluster_id: "7" }],
				cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		expect(result.clusterToCodes).toEqual({ "0": ["a", "b", "c", "d"] });
	});

	it("rejects invalid splits", () => {
		expect(() =>
			applyCodebookReview(
				{
					version: 1,
					clusters: {},
					operations: [
						{ type: "split", from_cluster_id: "0", splits: [{ new_cluster_id: "0a", code_ids: ["missing"] }] },
					],
					cluster_to_codes: { "0": ["a", "b"] },
				},
				baseClustered(),
			),
		).toThrow(CodebookReviewError);
	});

	it("rejects splits that leave codes behind or double-assign", () => {
		const v2 = (splits: Array<{ new_cluster_id: string; code_ids: string[] }>): EnrichedCodebook => ({
			version: 1,
			clusters: {},
			operations: [{ type: "split", from_cluster_id: "0", splits }],
			cluster_to_codes: { "0": ["a", "b"] },
		});
		expect(() => applyCodebookReview(v2([{ new_cluster_id: "x", code_ids: ["a"] }]), baseClustered())).toThrow(
			/unassigned/,
		);
		expect(() =>
			applyCodebookReview(
				v2([
					{ new_cluster_id: "x", code_ids: ["a", "b"] },
					{ new_cluster_id: "y", code_ids: ["a"] },
				]),
				baseClustered(),
			),
		).toThrow(/multiple/);
	});

	it("rejects codes in two clusters and unknown operations", () => {
		expect(() =>
			applyCodebookReview(
				{ version: 1, clusters: {}, operations: [], cluster_to_codes: { "0": ["a"], "1": ["a"] } },
				baseClustered(),
			),
		).toThrow(/appears in clusters/);
		expect(() =>
			applyCodebookReview(
				{
					version: 1,
					clusters: {},
					operations: [{ type: "explode" } as never],
					cluster_to_codes: { "0": ["a"] },
				},
				baseClustered(),
			),
		).toThrow(/unknown operation/);
	});

	it("falls back to clustered membership and rekeys ids numerically", () => {
		const clustered = { ...baseClustered(), cluster_to_codes: { "10": ["a"], "2": ["b"] } };
		const result = applyCodebookReview(
			{ version: 1, clusters: { "10": { label: "Ten" } }, operations: [], cluster_to_codes: {} },
			clustered,
		);
		expect(result.clusterToCodes).toEqual({ "0": ["b"], "1": ["a"] });
		expect(result.codebook).toEqual({ "0": "Cluster 0", "1": "Ten" });
		expect(result.provenance.entries.map((e) => e.source_cluster_id)).toEqual(["2", "10"]);
	});

	it("materializes clustered codes for the new membership", () => {
		const result = applyCodebookReview(
			{
				version: 1,
				clusters: { "1": { label: "Only" } },
				operations: [{ type: "drop", cluster_id: "0", code_disposition: "delete" }],
				cluster_to_codes: { "0": ["a", "b"], "1": ["c", "d"] },
			},
			baseClustered(),
		);
		const out = materializeClustered(result, { ...baseClustered(), dedup_map: { A: "a" } });
		expect(out).toMatchObject({
			k: 1,
			cluster_to_codes: { "0": ["c", "d"] },
			labels: [0, 0, 0, 0],
			dedup_map: { A: "a" },
		});
		expect(result.orphanedCodes).toEqual([]);
	});
});

describe("buildV1", () => {
	it("creates keep entries from labels and confidence", () => {
		const v1 = buildV1({ "0": "Lag" }, { "0": ["a"] }, { "0": { label: "Lag", confidence: 2, rationale: "why" } });
		expect(v1.clusters["0"]).toEqual({
			label: "Lag",
			description: "why",
			confidence: 2,
			source: "llm",
			needs_more_evidence: false,
			status: "keep",
		});
		expect(flatCodebook(v1)).toEqual({ "0": "Lag" });
		expect(buildV1({ "1": "X" }, {}).clusters["1"]!.confidence).toBe(1);
	});
});

describe("ReviewSession", () => {
	const proposal = () =>
		buildV1(
			{ "0": "Lag", "1": "Price", "2": "Story" },
			{ "0": ["lag a", "lag b", "price stray"], "1": ["price a"], "2": ["story a", "story b"] },
			{
				"0": { label: "Lag", confidence: 4, rationale: "" },
				"1": { label: "Price", confidence: 1, rationale: "" },
				"2": { label: "Story", confidence: 3, rationale: "" },
			},
		);

	it("lists least-confident clusters first", () => {
		expect(new ReviewSession(proposal()).list().map((c) => c.id)).toEqual(["1", "2", "0"]);
	});

	it("records provenance for renames and reassignments", () => {
		const s = new ReviewSession(proposal());
		s.rename("0", "  Network lag ");
		s.moveCodes(["price stray"], "1");
		expect(s.get("0").entry).toMatchObject({ label: "Network lag", source: "llm+edited" });
		expect(s.get("1").codes).toEqual(["price a", "price stray"]);
		expect(s.clusterOf("price stray")).toBe("1");
		expect(() => s.rename("0", " ")).toThrow(/empty/);
		expect(() => s.moveCodes(["ghost"], "1")).toThrow(/not in any cluster/);
	});

	it("produces payloads that apply cleanly for merge, split, drop, and create", () => {
		const s = new ReviewSession(proposal());
		s.merge(["2"], "0", "Lag and story");
		const newId = s.split("0", ["price stray"], "Stray price");
		s.drop(newId, "orphan");
		const created = s.create("Fresh", ["story b"]);
		expect(s.get(created).entry.source).toBe("human");
		const result = applyCodebookReview(s.toPayload(), baseClustered());
		const labels = Object.values(result.codebook);
		expect(labels).toEqual(expect.arrayContaining(["Lag and story", "Price", "Fresh"]));
		expect(result.orphanedCodes).toEqual(["price stray"]);
		const all = Object.values(result.clusterToCodes).flat();
		expect(all.sort()).toEqual(["lag a", "lag b", "price a", "story a", "story b"]);
	});

	it("never reuses cluster ids, including ids only seen in the operation log", () => {
		const s = new ReviewSession(proposal());
		s.merge(["2"], "0");
		const created = s.create("New", []);
		expect(created).toBe("3");
		const resumed = new ReviewSession({
			...s.toPayload(),
			operations: [...s.toPayload().operations, { type: "drop", cluster_id: "9", code_disposition: "delete" }],
		});
		expect(resumed.create("Later", [])).toBe("10");
	});

	it("validates split and merge inputs", () => {
		const s = new ReviewSession(proposal());
		expect(() => s.split("2", ["story a", "story b"], "x")).toThrow(/leave codes/);
		expect(() => s.split("2", [], "x")).toThrow(/at least one/);
		expect(() => s.split("2", ["lag a"], "x")).toThrow(/not in cluster/);
		expect(() => s.split("2", ["story a"], " ")).toThrow(/label/);
		expect(() => s.merge(["0"], "0")).toThrow(/other cluster/);
		expect(() => s.get("99")).toThrow(/Unknown cluster/);
	});

	it("blocks edits to dropped clusters until restored", () => {
		const s = new ReviewSession(proposal());
		s.drop("1", "delete");
		expect(() => s.rename("1", "x")).toThrow(/dropped/);
		expect(s.list().at(-1)!.id).toBe("1");
		s.restore("1");
		s.rename("1", "Back");
		expect(s.toPayload().operations).toEqual([]);
		expect(s.stats()).toMatchObject({ kept: 3, dropped: 0, edited: 1 });
	});

	it("undoes edits in order", () => {
		const s = new ReviewSession(proposal());
		s.rename("0", "A");
		s.toggleNeedsEvidence("0");
		expect(s.editCount).toBe(2);
		expect(s.undo()).toBe(true);
		expect(s.get("0").entry.needs_more_evidence).toBe(false);
		s.undo();
		expect(s.get("0").entry.label).toBe("Lag");
		expect(s.undo()).toBe(false);
		expect(s.canUndo).toBe(false);
	});

	it("ignores no-op edits", () => {
		const s = new ReviewSession(proposal());
		s.rename("0", "Lag");
		s.describe("0", "");
		s.moveCodes([], "1");
		expect(s.editCount).toBe(0);
		s.describe("0", "new");
		expect(s.get("0").entry.description).toBe("new");
	});
});

describe("review gateways", () => {
	async function setup() {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const paths = new RunPaths(join(dir, "run"));
		const viewerDir = join(dir, "viewer");
		return {
			paths,
			viewerDir,
			request: { slug: "s", researchQuestion: "rq", paths, viewerDir, proposal: buildV1({}, {}) },
		};
	}

	it("pausing gateway explains how to continue", async () => {
		const { request } = await setup();
		const decision = await pausingReviewGateway.review(request);
		expect(decision.kind).toBe("pending");
		expect(decision.kind === "pending" && decision.message).toContain("/idcoder review");
	});

	it("finds approvals in the run dir first, then the viewer drop folder", async () => {
		const { paths, viewerDir } = await setup();
		expect(await findSavedApproval(paths, viewerDir, "s")).toBeUndefined();
		await writeJson(join(viewerDir, "codebook-reviews", "s", "s-codebook_v2.json"), { version: 2 });
		expect(await findSavedApproval(paths, viewerDir, "s")).toMatch(/s-codebook_v2\.json$/);
		await writeJson(paths.codebookV2, { version: 2 });
		expect(await findSavedApproval(paths, viewerDir, "s")).toBe(paths.codebookV2);
	});

	it("file-wait gateway returns an approval as soon as it appears", async () => {
		const { paths, request } = await setup();
		const gateway = new FileWaitReviewGateway({ timeoutSec: 5, pollIntervalSec: 1 });
		setTimeout(
			() => void writeJson(paths.codebookV2, { version: 2, clusters: {}, operations: [], cluster_to_codes: {} }),
			50,
		);
		const decision = await gateway.review(request);
		expect(decision.kind).toBe("approved");
	});

	it("file-wait gateway times out to pending", async () => {
		const { request } = await setup();
		const decision = await new FileWaitReviewGateway({ timeoutSec: 1, pollIntervalSec: 1 }).review(request);
		expect(decision).toMatchObject({ kind: "pending" });
	});

	it("ignores unrelated files in the viewer folder", async () => {
		const { viewerDir, paths } = await setup();
		await writeJson(join(viewerDir, "codebook-reviews", "s", "codebook.json"), {});
		await writeFile(join(viewerDir, "codebook-reviews", "s", "notes.txt"), "x");
		expect(await findSavedApproval(paths, viewerDir, "s")).toBeUndefined();
	});
});
