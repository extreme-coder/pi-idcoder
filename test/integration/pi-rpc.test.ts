import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunPaths } from "../../src/artifacts/paths.ts";
import { fileExists, readJson, writeJson } from "../../src/core/fs.ts";
import { EvalPaths } from "../../src/evaluation/types.ts";
import type { RunState } from "../../src/pipeline/state.ts";
import type { EnrichedCodebook } from "../../src/review/schema.ts";
import { ReviewSession } from "../../src/review/session.ts";
import { MockOpenAI } from "../helpers/mock-openai.ts";
import { PiRpc, piAvailable } from "../helpers/pi-rpc.ts";
import { gameReviews } from "../helpers/simulated-llm.ts";

/**
 * The real pi binary, the real extension entry point, pi's real model runtime (streaming,
 * auth, payload hooks), and real HTTP — only the model behind the endpoint is simulated.
 */
describe.runIf(piAvailable)("pi integration over RPC (mock OpenAI-compatible endpoint)", () => {
	const mock = new MockOpenAI();
	let project: string;
	let pi: PiRpc;
	let paths: RunPaths;

	beforeAll(async () => {
		const base = await mock.start();
		project = await mkdtemp(join(tmpdir(), "idcoder-pi-"));
		const agentDir = join(project, ".agent");
		await mkdir(agentDir, { recursive: true });
		await writeJson(join(agentDir, "models.json"), {
			providers: { mock: { baseUrl: base, api: "openai-completions", apiKey: "test-key", models: [{ id: "sim" }] } },
		});
		const rows = gameReviews();
		await writeFile(join(project, "corpus.csv"), `id,text\n${rows.map((r, i) => `r${i},"${r}"`).join("\n")}\n`);
		await writeJson(join(project, ".idcoder", "config.json"), {
			study: { researchQuestion: "What frustrates players?", data: "corpus.csv", slug: "rpc" },
			models: { coder: "mock/sim", deductive: ["mock/sim"], judges: ["mock/sim"] },
			embeddings: { baseUrl: base, apiKeyEnv: "IDCODER_TEST_NO_KEY" },
			clustering: { kMin: 2, kMaxCap: 8 },
			evaluation: { levels: ["full"] },
		});
		paths = RunPaths.forSlug(project, "rpc");
		pi = new PiRpc({ cwd: project, agentDir, model: "mock/sim" });
	}, 60_000);

	afterAll(async () => {
		await pi?.close();
		await mock.stop();
	});

	it("loads the package: the /idcoder command and the agent skill, nothing else", async () => {
		const response = await pi.command({ type: "get_commands" });
		const names = ((response.data as { commands: Array<{ name: string }> }).commands ?? []).map((c) => c.name);
		expect(names).toEqual(expect.arrayContaining(["idcoder", "skill:idcoder"]));
		expect(names.filter((n) => n.startsWith("skill:"))).toEqual(["skill:idcoder"]);
	});

	it("runs to the human gate, pauses, and reports what to do", async () => {
		const message = await pi.idcoder("run");
		expect(message).toContain("is paused at Codebook review (human)");
		expect(message).toContain("/idcoder review");
		const state = await readJson<RunState>(paths.state);
		expect(state.stages.codebook_review.status).toBe("paused");
		expect(pi.records.some((r) => r.type === "extension_ui_request" && r.method === "setWidget")).toBe(true);
		const chat = mock.requests.filter((r) => r.path.endsWith("/chat/completions"));
		expect(chat[0]!.body.model).toBe("sim");
		expect(chat[0]!.body.stream).toBe(true);
		const system = (chat[0]!.body.messages as Array<{ role: string; content: unknown }>).find(
			(m) => m.role === "system" || m.role === "developer",
		);
		expect(JSON.stringify(system?.content)).toContain("Open Coding");
		expect(mock.requests.some((r) => r.path.endsWith("/embeddings"))).toBe(true);
	}, 120_000);

	it("resumes after a researcher's approval and completes every stage", async () => {
		const proposal = await readJson<EnrichedCodebook>(paths.codebookV1);
		const review = new ReviewSession(proposal);
		review.rename(review.list()[0]!.id, "Researcher label");
		await writeJson(paths.codebookV2, review.toPayload());

		const message = await pi.idcoder("run");
		expect(message).toContain('ID-Coder run "rpc" completed.');
		const state = await readJson<RunState>(paths.state);
		expect(Object.values(state.stages).every((s) => s.status === "done")).toBe(true);
		const codebook = await readJson<{ codebook: Record<string, string> }>(paths.codebook);
		expect(Object.values(codebook.codebook)).toContain("Researcher label");
		expect(
			await fileExists(join(project, ".idcoder", "viewer-data", "projects", "rpc", "gt_global_graph.json")),
		).toBe(true);

		const enrichment = mock.requests.find((r) => r.skill === "codebook_enrichment")!;
		expect(enrichment.body.response_format).toMatchObject({
			type: "json_schema",
			json_schema: { name: "codebook_entry" },
		});
	}, 180_000);

	it("evaluates through pi with deductive agents and judges", async () => {
		const message = await pi.idcoder("evaluate");
		expect(message).toContain("Evaluation steps: recode, agreement, disagreements, judge, summary");
		const evalPaths = new EvalPaths(paths.evaluation);
		expect(await fileExists(evalPaths.summaryMarkdown)).toBe(true);
		expect(mock.requests.some((r) => r.skill === "deductive_recode")).toBe(true);
	}, 180_000);

	it("reports status, usage, and argument errors", async () => {
		expect(await pi.idcoder("status")).toContain("✓ Viewer export");
		expect(await pi.idcoder("usage")).toContain("Total LLM calls:");
		await pi.command({ type: "prompt", message: "/idcoder run --from nowhere" });
		expect(pi.notifications().some((n) => n.includes('Unknown stage "nowhere"'))).toBe(true);
	}, 60_000);
});
