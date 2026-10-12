import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { RunPaths } from "../../src/artifacts/paths.ts";
import { fileExists, readJson, writeJson } from "../../src/core/fs.ts";
import { ArgsError, completeArgs, parseCommand, tokenize } from "../../src/extension/args.ts";
import { BusyError, IdcoderController, TerminalReviewGateway } from "../../src/extension/controller.ts";
import { formatRunResult, nextStep, ProgressView } from "../../src/extension/format.ts";
import { truncateText } from "../../src/extension/inspect.ts";
import { browserCommand, CONFIG_FLAG, registerIdcoder } from "../../src/extension/register.ts";
import { toPiUsage } from "../../src/extension/tools.ts";
import type { RunState } from "../../src/pipeline/state.ts";
import { freshState } from "../../src/pipeline/state.ts";
import { BrowserReviewGateway } from "../../src/review/browser-gateway.ts";
import { FileWaitReviewGateway, pausingReviewGateway } from "../../src/review/gateway.ts";
import { ViewerHost } from "../../src/viewer/host.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";
import { FakePi, fakeContext } from "../helpers/fake-pi.ts";
import { FakeUi, KEYS } from "../helpers/fake-ui.ts";
import { testConfig, writeCorpus } from "../helpers/harness.ts";
import { gameReviews, SimulatedGateway } from "../helpers/simulated-llm.ts";

async function project(config: Record<string, unknown> = {}) {
	const dir = await mkdtemp(join(tmpdir(), "idcoder-ext-"));
	await writeCorpus(dir, gameReviews());
	await writeJson(join(dir, ".idcoder", "config.json"), {
		study: { researchQuestion: "What frustrates players?", data: "corpus.csv", slug: "ext" },
		clustering: { kMin: 2, kMaxCap: 8 },
		viewer: { port: 0, cacheDir: join(dir, "viewer-cache") },
		...config,
	});
	return { dir, paths: RunPaths.forSlug(dir, "ext") };
}

const viewerZip = zipSync({
	"dist/index.html": strToU8("<html><head></head></html>"),
	"dist/assets/index-a.js": strToU8(
		'function wue(n,e){const t=new Blob([JSON.stringify(e,null,2)],{type:"application/json"}),i=URL.createObjectURL(t),r=document.createElement("a");r.href=i,r.download=n,r.click(),URL.revokeObjectURL(i)}',
	),
});

function install(options: { ui?: FakeUi; gateway?: SimulatedGateway } = {}) {
	const pi = new FakePi();
	const gateway = options.gateway ?? new SimulatedGateway();
	const opened: string[] = [];
	const controller = registerIdcoder(pi.asApi(), {
		gatewayFor: () => gateway,
		embedderFor: () => new HashingEmbedder(),
		viewer: new ViewerHost({ fetch: async () => new Response(new Blob([viewerZip as Uint8Array<ArrayBuffer>])) }),
		openUrl: async (url) => void opened.push(url),
		...(options.ui ? { uiFor: () => options.ui! } : {}),
	});
	return { pi, gateway, controller, opened };
}

describe("command arguments", () => {
	it("tokenizes quoted arguments", () => {
		expect(tokenize(`run --config "my dir/c.json" 'x y' z\\"q`)).toEqual([
			"run",
			"--config",
			"my dir/c.json",
			"x y",
			'z\\"q',
		]);
	});

	it("parses subcommands and options", () => {
		expect(parseCommand("")).toEqual({ sub: "help", positional: [] });
		expect(parseCommand("run --from hierarchy --until tree_assembly --config c.json")).toEqual({
			sub: "run",
			positional: [],
			from: "hierarchy",
			until: "tree_assembly",
			config: "c.json",
		});
		expect(parseCommand("evaluate --steps recode,summary").steps).toEqual(["recode", "summary"]);
		expect(parseCommand("judge alice").positional).toEqual(["alice"]);
	});

	it.each([
		["nope", /Unknown subcommand/],
		["run --from mars", /Unknown stage/],
		["run --from", /needs a value/],
		["evaluate --steps recode,dance", /dance/],
		["run --verbose", /Unknown option/],
	])("rejects %s", (input, message) => {
		expect(() => parseCommand(input)).toThrow(ArgsError);
		expect(() => parseCommand(input)).toThrow(message);
	});

	it("completes subcommands, options, and stage names", () => {
		expect(completeArgs("ru")).toEqual([{ value: "run", label: "run" }]);
		expect(completeArgs("run --f")).toEqual([{ value: "run --from", label: "--from" }]);
		expect(completeArgs("run --from hier")).toEqual([{ value: "run --from hierarchy", label: "hierarchy" }]);
		expect(completeArgs("evaluate --st")).toEqual([{ value: "evaluate --steps", label: "--steps" }]);
		expect(completeArgs("status --c")).toEqual([{ value: "status --config", label: "--config" }]);
		expect(completeArgs("zzz")).toBeNull();
	});
});

describe("formatting", () => {
	it("tracks progress for the widget and status bar", () => {
		const view = new ProgressView();
		view.apply({ type: "stage_start", stage: "open_coding", title: "Open coding", index: 0, total: 14 });
		view.apply({
			type: "stage_progress",
			stage: "open_coding",
			progress: { done: 3, total: 10, message: "review 3" },
		});
		expect(view.statusText()).toBe("idcoder: Open coding 3/10 · review 3");
		view.apply({ type: "stage_end", stage: "open_coding", status: "done", summary: "ok" });
		view.apply({ type: "stage_error", stage: "source_memory", error: "boom" });
		expect(view.lines()).toEqual(["✓ Open coding — ok", "✗ Source memory — boom"]);
		expect(view.statusText()).toBeUndefined();
		expect(new ProgressView().lines(10)).toEqual([]);
	});

	it("suggests the next step for every state", () => {
		const state = freshState("s", testConfig());
		expect(nextStep(state)).toContain("continue from Open coding");
		state.stages.open_coding = { status: "failed", error: "x" };
		expect(nextStep(state)).toContain("resumes from Open coding");
		state.stages.open_coding = { status: "paused" };
		expect(nextStep(state)).toContain("/idcoder review");
		for (const id of Object.keys(state.stages)) state.stages[id as keyof RunState["stages"]] = { status: "done" };
		expect(nextStep(state)).toContain("/idcoder evaluate");
		expect(formatRunResult({ status: "aborted", stage: "hierarchy", state }, "s", "/r")).toContain(
			"was stopped during Hierarchy",
		);
	});

	it("truncates long inspection output and converts usage", () => {
		expect(truncateText("abcdef", 3, "/f")).toBe("abc\n\n[truncated 3 characters; full content in /f]");
		expect(toPiUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 3, cost: 0.5 })).toMatchObject({
			totalTokens: 3,
			cost: { total: 0.5 },
		});
	});

	it("opens the browser with the platform's command", () => {
		expect(browserCommand("darwin", "u")).toEqual(["open", ["u"]]);
		expect(browserCommand("win32", "u")).toEqual(["cmd", ["/c", "start", "", "u"]]);
		expect(browserCommand("linux", "u")).toEqual(["xdg-open", ["u"]]);
	});
});

describe("registration", () => {
	it("registers tools, the command, the config flag, and shutdown cleanup", () => {
		const { pi } = install();
		expect([...pi.tools.keys()]).toEqual(["idcoder_run", "idcoder_status", "idcoder_evaluate", "idcoder_inspect"]);
		expect([...pi.commands.keys()]).toEqual(["idcoder"]);
		expect(pi.flags.has(CONFIG_FLAG)).toBe(true);
		expect(pi.handlers.has("session_shutdown")).toBe(true);
	});

	it("chooses the review channel from mode and config", async () => {
		const { controller } = install();
		const tui = fakeContext({ cwd: "/p", mode: "tui" }).ctx;
		const print = fakeContext({ cwd: "/p", mode: "print" }).ctx;
		const config = (review: Record<string, unknown>) => testConfig({ review });
		expect(controller.reviewGateway(tui, config({ mode: "auto" }))).toBeInstanceOf(TerminalReviewGateway);
		expect(controller.reviewGateway(tui, config({ mode: "tui" }))).toBeInstanceOf(TerminalReviewGateway);
		expect(controller.reviewGateway(print, config({ mode: "auto" }))).toBe(pausingReviewGateway);
		expect(controller.reviewGateway(print, config({ mode: "auto", waitForFile: true }))).toBeInstanceOf(
			FileWaitReviewGateway,
		);
		expect(controller.reviewGateway(print, config({ mode: "browser" }))).toBeInstanceOf(BrowserReviewGateway);
		expect(controller.reviewGateway(tui, config({ mode: "file" }))).toBe(pausingReviewGateway);
	});

	it("resolves the config path from params, the CLI flag, or the default", () => {
		const { controller, pi } = install();
		expect(controller.configPath("/proj")).toBe("/proj/.idcoder/config.json");
		expect(controller.configPath("/proj", "custom.json")).toBe("/proj/custom.json");
		pi.flagValues[CONFIG_FLAG] = "/abs/c.json";
		expect(controller.configPath("/proj")).toBe("/abs/c.json");
	});
});

describe("tools", () => {
	it("idcoder_run pauses at the gate, terminates the turn, and reports usage and progress", async () => {
		const { dir, paths } = await project();
		const { pi } = install();
		const { ctx, statuses, widgets } = fakeContext({ cwd: dir, mode: "rpc" });
		const updates: unknown[] = [];
		const result = await pi.tool("idcoder_run", {}, ctx, (u) => updates.push(u));
		expect(result.terminate).toBe(true);
		expect(result.isError).toBe(false);
		expect(result.content[0]!.text).toContain("paused at Codebook review");
		expect(result.details.status).toBe("paused");
		expect(result.usage!.totalTokens).toBeGreaterThan(0);
		expect(updates.length).toBeGreaterThan(0);
		expect(statuses.at(-1)).toBeUndefined();
		expect(widgets.at(-1)).toBeUndefined();
		expect(await fileExists(paths.codebookV1)).toBe(true);

		const status = await pi.tool("idcoder_status", {}, ctx);
		expect(status.content[0]!.text).toContain("⏸ Codebook review (human)");
		const inspect = await pi.tool("idcoder_inspect", { what: "codebook" }, ctx);
		expect(inspect.content[0]!.text).toMatch(/Codebook \(\d+ clusters\)/);
		const cluster = await pi.tool("idcoder_inspect", { what: "cluster" }, ctx);
		expect(cluster.content[0]!.text).toContain("Pass cluster_id");
		const trace = await pi.tool("idcoder_inspect", { what: "trace", max_chars: 500 }, ctx);
		expect(trace.content[0]!.text.length).toBeLessThan(700);
	});

	it("idcoder_run completes in the terminal by opening the review screen inline", async () => {
		const { dir, paths } = await project({ evaluation: { levels: ["full"] } });
		const ui = new FakeUi({ keys: [["a"]], confirms: [true] });
		const { pi } = install({ ui });
		const { ctx } = fakeContext({ cwd: dir, mode: "tui" });
		const result = await pi.tool("idcoder_run", {}, ctx);
		expect(result.details.status).toBe("completed");
		expect(result.terminate).toBe(false);
		expect(await readJson(paths.codebookProvenance)).toMatchObject({ review_id: "ext" });

		for (const what of ["codebook", "meta_themes", "report", "usage"]) {
			const view = await pi.tool("idcoder_inspect", { what }, ctx);
			expect(view.content[0]!.text, what).not.toMatch(/^No /);
		}
		const cluster = await pi.tool("idcoder_inspect", { what: "cluster", cluster_id: "0" }, ctx);
		expect(cluster.content[0]!.text).toContain("Definition:");

		const evaluation = await pi.tool("idcoder_evaluate", { steps: ["recode", "agreement", "summary"] }, ctx);
		expect(evaluation.content[0]!.text).toContain("Evaluation steps: recode, agreement, summary");
		const summary = await pi.tool("idcoder_inspect", { what: "evaluation" }, ctx);
		expect(summary.content[0]!.text).toContain("# ID-Coder evaluation");
	});

	it("reports a failed stage as an error result", async () => {
		const { dir } = await project({ review: { enabled: false } });
		const failing = new SimulatedGateway((_ref, _skill, request) =>
			request.prompt.includes("You are organising the results") ? "garbage" : undefined,
		);
		const { pi } = install({ gateway: failing });
		const result = await pi.tool("idcoder_run", {}, fakeContext({ cwd: dir, mode: "print" }).ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]!.text).toContain("failed at Meta-themes");
	});

	it("refuses a second concurrent run of the same study and aborts runs on shutdown", async () => {
		const { dir } = await project();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = new SimulatedGateway(() => undefined);
		const original = slow.complete.bind(slow);
		slow.complete = async (ref, request) => {
			await gate;
			return original(ref, request);
		};
		const { pi, controller } = install({ gateway: slow });
		const { ctx } = fakeContext({ cwd: dir, mode: "print" });
		const first = pi.tool("idcoder_run", {}, ctx);
		await new Promise((r) => setTimeout(r, 50));
		expect(controller.isRunning("ext")).toBe(true);
		await expect(controller.run(ctx)).rejects.toBeInstanceOf(BusyError);
		await pi.emit("session_shutdown");
		release();
		const result = await first;
		expect(result.details.status).toBe("aborted");
		expect(controller.isRunning("ext")).toBe(false);
	});

	it("explains a missing config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idcoder-ext-"));
		const { pi } = install();
		await expect(pi.tool("idcoder_status", {}, fakeContext({ cwd: dir }).ctx)).rejects.toThrow(/\/idcoder init/);
	});
});

describe("/idcoder command", () => {
	it("prints help, status, and usage, and reports bad arguments", async () => {
		const { dir } = await project();
		const { pi } = install();
		const fake = fakeContext({ cwd: dir, mode: "print" });
		await pi.command("help", fake.ctx);
		expect(pi.lastMessage()).toContain("/idcoder evaluate");
		await pi.command("status", fake.ctx);
		expect(pi.lastMessage()).toContain("○ Open coding");
		await pi.command("usage", fake.ctx);
		expect(pi.lastMessage()).toBe("No LLM usage recorded.");
		await pi.command("run --until nowhere", fake.ctx);
		expect(fake.notifications.at(-1)).toMatchObject({ type: "error" });
		await pi.command("review", fake.ctx);
		expect(fake.notifications.at(-1)!.message).toContain("needs the interactive terminal UI");
	});

	it("runs, reviews in the terminal, and resumes on confirmation", async () => {
		const { dir, paths } = await project();
		const ui = new FakeUi({ keys: [["r"], ["a"]], inputs: ["Edited by researcher"], confirms: [true] });
		const { pi } = install({ ui });
		const run = fakeContext({ cwd: dir, mode: "print" });
		await pi.command("run", run.ctx);
		expect(pi.lastMessage()).toContain("paused");
		expect(run.notifications.at(-1)).toEqual({ message: "ID-Coder: paused", type: "warning" });

		const review = fakeContext({ cwd: dir, mode: "tui", confirms: [true] });
		await pi.command("review", review.ctx);
		expect(review.notifications[0]!.message).toContain("Approval saved");
		expect(pi.lastMessage()).toContain("completed");
		expect(Object.values((await readJson<{ codebook: Record<string, string> }>(paths.codebook)).codebook)).toContain(
			"Edited by researcher",
		);

		await pi.command("review", review.ctx);
		expect(review.notifications.at(-1)!.message).toContain("already approved");
	});

	it("tells the user when nothing awaits review", async () => {
		const { dir } = await project();
		const { pi } = install();
		const fake = fakeContext({ cwd: dir, mode: "tui" });
		await pi.command("review", fake.ctx);
		expect(fake.notifications.at(-1)!.message).toContain("No codebook is waiting for review");
	});

	it("evaluates, then lets an annotator judge disagreements blind", async () => {
		const { dir } = await project({
			review: { enabled: false },
			models: { judges: ["sim/judge"] },
			evaluation: { levels: ["full"], human: { itemsPerAnnotator: 3 } },
		});
		const ui = new FakeUi({ keys: [["1"], ["s"], ["4"]] });
		const { pi } = install({ ui });
		const fake = fakeContext({ cwd: dir, mode: "tui" });
		await pi.command("judge alice", fake.ctx);
		expect(fake.notifications.at(-1)!.message).toContain("No disagreement items yet");
		await pi.command("run", fake.ctx);
		await pi.command("evaluate", fake.ctx);
		expect(pi.lastMessage()).toContain("Evaluation steps");
		await pi.command("judge alice", fake.ctx);
		expect(fake.notifications.at(-1)!.message).toMatch(/alice: 2 judged, 1 skipped/);
		await pi.command("evaluate --steps summary", fake.ctx);
		const summary = await readFile(join(dir, ".idcoder/runs/ext/evaluation/summary.md"), "utf8");
		expect(summary).toContain("## Human judges");
	});

	it("opens the viewer in the browser", async () => {
		const { dir } = await project();
		const { pi, opened } = install();
		const fake = fakeContext({ cwd: dir, mode: "tui" });
		await pi.command("viewer", fake.ctx);
		expect(opened).toHaveLength(1);
		expect(fake.notifications.at(-1)!.message).toContain(opened[0]!);
		await pi.emit("session_shutdown");
	});

	it("creates a config interactively", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idcoder-ext-"));
		await writeFile(join(dir, "reviews.csv"), "text\nhello\n");
		const { pi } = install();
		const fake = fakeContext({
			cwd: dir,
			mode: "tui",
			inputs: ["Why do players quit?"],
			selects: ["reviews.csv"],
			confirms: [true],
		});
		await pi.command("init", fake.ctx);
		expect(fake.notifications.at(-1)!.message).toContain("Wrote");
		const config = await readJson<{ study: { data: string }; models: { coder: string } }>(
			join(dir, ".idcoder", "config.json"),
		);
		expect(config.study.data).toBe("reviews.csv");
		expect(config.models.coder).toBe("sim/model");

		const again = fakeContext({ cwd: dir, mode: "tui", confirms: [false] });
		await pi.command("init", again.ctx);
		expect(again.notifications.at(-1)!.message).toBe("Kept the existing config.");
		const cancelled = fakeContext({ cwd: dir, mode: "tui", confirms: [true], inputs: [" "] });
		await pi.command("init", cancelled.ctx);
		expect(cancelled.notifications.at(-1)!.message).toBe("Init cancelled.");
	});

	it("surfaces errors as notifications instead of throwing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idcoder-ext-"));
		const { pi } = install();
		const fake = fakeContext({ cwd: dir, mode: "print" });
		await pi.command("status", fake.ctx);
		expect(fake.notifications.at(-1)).toMatchObject({ type: "error" });
		expect(fake.notifications.at(-1)!.message).toContain("No idcoder config");
	});
});

describe("terminal review gateway", () => {
	it("returns pending when the researcher leaves without approving", async () => {
		const { dir, paths } = await project();
		const gateway = new TerminalReviewGateway(new FakeUi({ keys: [[KEYS.escape]] }), testConfig(), dir);
		const decision = await gateway.review({
			slug: "ext",
			researchQuestion: "",
			paths,
			viewerDir: join(dir, ".idcoder/viewer-data"),
			proposal: { version: 1, clusters: {}, operations: [], cluster_to_codes: {} },
		});
		expect(decision).toMatchObject({ kind: "pending" });
	});
});

describe("controller", () => {
	it("exposes the run state without running anything", async () => {
		const { dir } = await project();
		const controller = new IdcoderController({
			gatewayFor: () => new SimulatedGateway(),
			embedderFor: () => new HashingEmbedder(),
			viewer: new ViewerHost(),
			openUrl: async () => {},
			configFlag: () => undefined,
		});
		const { state, session } = await controller.state(fakeContext({ cwd: dir }).ctx);
		expect(session.slug).toBe("ext");
		expect(state.stages.open_coding.status).toBe("pending");
	});
});
