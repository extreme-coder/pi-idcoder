import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunPaths } from "../../src/artifacts/paths.ts";
import type {
	ClusteredCodesFile,
	CodebookFile,
	DimensionsEnrichedFile,
	MetaThemesFile,
} from "../../src/artifacts/types.ts";
import { readJson, readJsonl, writeJson } from "../../src/core/fs.ts";
import { squashWhitespace } from "../../src/core/text.ts";
import { parseCsv } from "../../src/corpus/load.ts";
import type { AgreementReport } from "../../src/evaluation/agreement.ts";
import { EvalPaths, type JudgeRow, type RecodeRow } from "../../src/evaluation/types.ts";
import { parseOpenCodingSnippets } from "../../src/evidence/source-memory.ts";
import type { UsageRecord } from "../../src/llm/usage.ts";
import type { RunState } from "../../src/pipeline/state.ts";
import type { EnrichedCodebook } from "../../src/review/schema.ts";
import { PiRpc, piAvailable } from "../helpers/pi-rpc.ts";

/**
 * Live suite: real models through OpenCode Zen, driven through the real pi binary. Assertions are
 * invariants that must hold for any competent model, never exact outputs. Opt in with
 * `npm run test:live` and OPENCODE_API_KEY. Zen serves no embeddings, so clustering defaults to
 * `llm`; set IDCODER_LIVE_CLUSTERING=embedding plus IDCODER_LIVE_EMBED_* to exercise K-means.
 */
const env = process.env;
const enabled = Boolean(env.IDCODER_LIVE && env.OPENCODE_API_KEY && piAvailable);
const CODER = env.IDCODER_LIVE_CODER ?? "opencode/deepseek-v4-flash";
const DEDUCTIVE = (env.IDCODER_LIVE_DEDUCTIVE ?? "opencode/glm-5.3-flash").split(",");
const JUDGES = (env.IDCODER_LIVE_JUDGES ?? "opencode/gpt-5.4-nano").split(",");
const CLUSTERING = env.IDCODER_LIVE_CLUSTERING ?? "llm";
const EMBEDDINGS = {
	baseUrl: env.IDCODER_LIVE_EMBED_BASE_URL ?? "https://api.openai.com/v1",
	apiKeyEnv: env.IDCODER_LIVE_EMBED_KEY_ENV ?? "OPENAI_API_KEY",
	model: env.IDCODER_LIVE_EMBED_MODEL ?? "text-embedding-3-small",
};
const MAX_USD = Number(env.IDCODER_LIVE_MAX_USD ?? "1.00");
const OFF_TOPIC = ["r13", "r14", "r23"];

describe.runIf(enabled)("live: full ID-Coder run on real models", () => {
	let project: string;
	let paths: RunPaths;
	let pi: PiRpc;
	let docs: Map<string, string>;

	beforeAll(async () => {
		project = await mkdtemp(join(tmpdir(), "idcoder-live-"));
		const agentDir = join(project, ".agent");
		await mkdir(agentDir, { recursive: true });
		await copyFile(new URL("../fixtures/corpus/live-reviews.csv", import.meta.url), join(project, "corpus.csv"));
		docs = new Map(
			parseCsv(await readFile(join(project, "corpus.csv"), "utf8"), {}).map((d) => [d.sourceId!, d.text]),
		);
		await writeJson(join(project, ".idcoder", "config.json"), {
			study: { researchQuestion: "What do players complain about?", data: "corpus.csv", slug: "live" },
			models: { coder: CODER, deductive: DEDUCTIVE, judges: JUDGES, maxRetries: 4 },
			embeddings: EMBEDDINGS,
			openCoding: { validator: true, workers: 4 },
			clustering: { method: CLUSTERING, kMin: 3, kMaxCap: 8 },
			labeling: { samples: 3, sampleSize: 6, workers: 4 },
			evaluation: { levels: ["theme_only", "full"], recode: { batchSize: 10 }, judge: { batchSize: 5 } },
		});
		paths = RunPaths.forSlug(project, "live");
		pi = new PiRpc({
			cwd: project,
			agentDir,
			model: CODER,
			env: { OPENCODE_API_KEY: env.OPENCODE_API_KEY, [EMBEDDINGS.apiKeyEnv]: env[EMBEDDINGS.apiKeyEnv] },
			offline: false,
		});
	}, 60_000);

	afterAll(async () => {
		await pi?.close();
	});

	it("open codes are grounded in their documents and off-topic texts abstain", async () => {
		const message = await pi.idcoder("run --until source_memory", 900_000);
		expect(message).toContain("completed");
		const snippets = parseOpenCodingSnippets(await readFile(paths.openCodesMarkdown, "utf8"));
		const ids = [...docs.keys()];
		const grounded = snippets.filter((s) =>
			squashWhitespace(docs.get(ids[s.review_id - 1]!)!.toLowerCase()).includes(
				squashWhitespace(s.quote.toLowerCase()).replace(/[.…]+$/, ""),
			),
		);
		expect(grounded.length / snippets.length).toBeGreaterThanOrEqual(0.85);
		for (const id of OFF_TOPIC) {
			expect(
				snippets.filter((s) => ids[s.review_id - 1] === id),
				id,
			).toHaveLength(0);
		}
		const perDoc = new Map<number, number>();
		for (const s of snippets) perDoc.set(s.review_id, (perDoc.get(s.review_id) ?? 0) + 1);
		expect(Math.max(...perDoc.values())).toBeLessThanOrEqual(3);
	}, 900_000);

	it("pauses for review, then completes with a coherent codebook and hierarchy", async () => {
		expect(await pi.idcoder("run", 900_000)).toContain("paused");
		const proposal = await readJson<EnrichedCodebook>(paths.codebookV1);
		await writeJson(paths.codebookV2, proposal);
		expect(await pi.idcoder("run", 1_800_000)).toContain("completed");

		const state = await readJson<RunState>(paths.state);
		expect(Object.values(state.stages).every((s) => s.status === "done")).toBe(true);
		const codebook = await readJson<CodebookFile>(paths.codebook);
		const clustered = await readJson<ClusteredCodesFile>(paths.clusteredCodes);
		const metas = await readJson<MetaThemesFile>(paths.metaThemes);
		const clusterIds = Object.keys(codebook.codebook).sort();
		expect(metas.meta_themes.flatMap((m) => m.cluster_ids.map(String)).sort()).toEqual(clusterIds);
		expect(metas.meta_themes.length).toBeGreaterThanOrEqual(2);
		for (const id of clusterIds) {
			const entry = codebook.codebook_enriched![id]!;
			expect(entry.definition.length, id).toBeGreaterThan(20);
			expect(entry.inclusion.length + entry.exclusion.length, id).toBeGreaterThan(0);
		}
		const labels = Object.values(codebook.codebook).map((l) => l.toLowerCase());
		expect(new Set(labels).size).toBe(labels.length);
		expect(Object.values(clustered.cluster_to_codes).flat().length).toBeGreaterThan(10);
		const dims = await readJson<DimensionsEnrichedFile>(paths.metaThemesEnriched);
		expect(dims.meta_themes_enriched.every((d) => d.definition.length > 0)).toBe(true);
		const report = await readFile(paths.researchReport, "utf8");
		for (const section of ["## Research question", "## Graph structure", "## Research answer"])
			expect(report).toContain(section);
	}, 2_700_000);

	it("parses structured output reliably", async () => {
		const trace = await readFile(paths.trace, "utf8");
		const count = (event: string) => (trace.match(new RegExp(`=== ${event} ===`, "g")) ?? []).length;
		const usage = await readJsonl<UsageRecord>(paths.usage);
		const calls = usage.length;
		const parseFailures =
			count("HIGH_LEVEL_LLM_ERROR") + count("ENRICH_WARN") + count("DIM_ENRICH_WARN") + count("HIERARCHY_LLM_ERROR");
		expect(parseFailures / calls).toBeLessThan(0.05);
		expect(count("ENRICH_RETRY") + count("DIM_ENRICH_RETRY")).toBeLessThanOrEqual(Math.ceil(calls * 0.1));
	});

	it("evaluates: agreement is measurable and judges answer nearly everything", async () => {
		expect(await pi.idcoder("evaluate", 1_800_000)).toContain("Evaluation steps");
		const evalPaths = new EvalPaths(paths.evaluation);
		const agreement = await readJson<AgreementReport>(evalPaths.agreement);
		const full = agreement.levels.find((l) => l.level === "full")!;
		for (const cell of full.cells) {
			expect(cell.alpha, cell.model).not.toBeNull();
			expect(cell.n_unresolved / cell.n_total, cell.model).toBeLessThan(0.05);
			expect(cell.percent_agreement!, cell.model).toBeGreaterThan(0.4);
		}
		for (const model of DEDUCTIVE) {
			const rows = await readJsonl<RecodeRow>(evalPaths.recode(model, "full"));
			expect(rows.every((r) => r.status === "classified")).toBe(true);
		}
		for (const judge of JUDGES) {
			const rows = await readJsonl<JudgeRow>(evalPaths.judge(judge));
			if (rows.length) expect(rows.filter((r) => r.status === "judged").length / rows.length).toBeGreaterThan(0.95);
		}
	}, 1_800_000);

	it("stays within the cost budget", async () => {
		const usage = await readJsonl<UsageRecord>(paths.usage);
		const cost = usage.reduce((sum, r) => sum + (r.cost || 0), 0);
		expect(cost).toBeLessThan(MAX_USD);
	});
});
