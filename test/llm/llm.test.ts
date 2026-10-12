import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import { AbortedError } from "../../src/core/concurrency.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { decoratePayload, splitModelRef } from "../../src/llm/gateway.ts";
import { LlmService, modelRefForRole } from "../../src/llm/service.ts";
import { SkillLibrary, stripFrontmatter } from "../../src/llm/skills.ts";
import { isTransientMessage, LlmError } from "../../src/llm/types.ts";
import { summarizeUsage, UsageRecorder } from "../../src/llm/usage.ts";
import { ScriptedGateway } from "../helpers/fake-llm.ts";

const models = resolveConfig({
	study: { researchQuestion: "q", data: "d.csv" },
	models: { coder: "p/coder", validator: "p/validator", maxRetries: 2 },
}).models;

function service(gateway: ScriptedGateway, usage = new UsageRecorder(undefined)) {
	return new LlmService({
		gateway,
		models,
		skills: new SkillLibrary({ enabled: true }),
		usage,
		logger: silentLogger,
		retryBaseMs: 0,
	});
}

describe("skills", () => {
	it("strips YAML frontmatter", () => {
		expect(stripFrontmatter("---\nname: x\n---\nBody\n")).toBe("Body");
		expect(stripFrontmatter("  plain  ")).toBe("plain");
		expect(stripFrontmatter("---\nunterminated")).toBe("---\nunterminated");
	});

	it("loads bundled skills and returns empty for unknown or disabled", async () => {
		const lib = new SkillLibrary({ enabled: true });
		expect(await lib.systemPrompt("open_coding")).toContain("# Open Coding");
		expect(await lib.systemPrompt("open_coding")).not.toContain("name: open-coding");
		expect(await lib.systemPrompt("codebook_batch_enrich")).toBe("");
		expect(await lib.systemPrompt("../etc")).toBe("");
		expect(await new SkillLibrary({ enabled: false }).systemPrompt("open_coding")).toBe("");
	});

	it("prefers an override directory and falls back to bundled skills", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		await writeFile(join(dir, "open_coding.md"), "---\na: 1\n---\nCustom", "utf8");
		const lib = new SkillLibrary({ enabled: true, overrideDir: dir });
		expect(await lib.systemPrompt("open_coding")).toBe("Custom");
		expect(await lib.systemPrompt("meta_theme_grouping")).toContain("Meta-Theme Grouping");
	});
});

describe("model refs", () => {
	it("splits provider/model ids with slashes in the id", () => {
		expect(splitModelRef("openrouter/google/gemma-4")).toEqual({ provider: "openrouter", id: "google/gemma-4" });
		expect(splitModelRef("nope")).toBeUndefined();
		expect(splitModelRef("/x")).toBeUndefined();
		expect(splitModelRef("x/")).toBeUndefined();
	});

	it("falls back to the coder model per role", () => {
		expect(modelRefForRole(models, "validator")).toBe("p/validator");
		expect(modelRefForRole(models, "report")).toBe("p/coder");
	});
});

describe("decoratePayload", () => {
	const schema = { name: "x", schema: { type: "object" } };

	it("adds response_format and extra body for chat completions", () => {
		expect(
			decoratePayload("openai-completions", { model: "m" }, schema, {
				chat_template_kwargs: { enable_thinking: false },
			}),
		).toEqual({
			model: "m",
			chat_template_kwargs: { enable_thinking: false },
			response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } },
		});
	});

	it("uses text.format for the responses API", () => {
		expect(decoratePayload("openai-responses", { text: { verbosity: "low" } }, schema, undefined)).toEqual({
			text: { verbosity: "low", format: { type: "json_schema", name: "x", schema: { type: "object" } } },
		});
	});

	it("leaves other APIs untouched", () => {
		expect(decoratePayload("anthropic-messages", { a: 1 }, schema, { b: 2 })).toBeUndefined();
		expect(decoratePayload("openai-completions", "raw", schema, undefined)).toBeUndefined();
	});
});

describe("LlmService", () => {
	it("routes roles, sends the skill system prompt, and trims output", async () => {
		const gateway = new ScriptedGateway(() => ({ text: "  PASS  " }));
		const res = await service(gateway).complete({ skill: "validate_open_codes", prompt: "p", role: "validator" });
		expect(res.text).toBe("PASS");
		expect(gateway.calls[0]!.ref).toBe("p/validator");
		expect(gateway.calls[0]!.request.system).toContain("Validate Open Codes");
		expect(gateway.calls[0]!.request.maxTokens).toBe(4096);
		expect(gateway.calls[0]!.request.temperature).toBe(0);
	});

	it("uses an explicit model and system override", async () => {
		const gateway = new ScriptedGateway(() => ({ text: "{}" }));
		await service(gateway).complete({ skill: "llm_clustering", prompt: "p", system: "SYS", model: "x/judge" });
		expect(gateway.calls[0]).toMatchObject({ ref: "x/judge", request: { system: "SYS" } });
	});

	it("retries transient failures then succeeds", async () => {
		const gateway = new ScriptedGateway((_ref, _req, call) =>
			call < 3 ? { stopReason: "error", errorMessage: "429 rate limit" } : { text: "ok" },
		);
		expect((await service(gateway).complete({ skill: "s", prompt: "p" })).text).toBe("ok");
		expect(gateway.calls).toHaveLength(3);
	});

	it("gives up after maxRetries", async () => {
		const gateway = new ScriptedGateway(() => {
			throw new Error("ECONNRESET");
		});
		await expect(service(gateway).complete({ skill: "s", prompt: "p" })).rejects.toBeInstanceOf(LlmError);
		expect(gateway.calls).toHaveLength(3);
	});

	it("does not retry permanent errors", async () => {
		const gateway = new ScriptedGateway(() => ({ stopReason: "error", errorMessage: "invalid api key" }));
		await expect(service(gateway).complete({ skill: "s", prompt: "p" })).rejects.toThrow("invalid api key");
		expect(gateway.calls).toHaveLength(1);
	});

	it("surfaces aborts without retrying", async () => {
		const gateway = new ScriptedGateway(() => ({ stopReason: "aborted" }));
		await expect(service(gateway).complete({ skill: "s", prompt: "p" })).rejects.toBeInstanceOf(AbortedError);
		const controller = new AbortController();
		controller.abort();
		await expect(
			service(gateway).complete({ skill: "s", prompt: "p", signal: controller.signal }),
		).rejects.toBeInstanceOf(AbortedError);
	});

	it("records usage per stage", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const usage = new UsageRecorder(join(dir, "usage.jsonl"));
		const gateway = new ScriptedGateway(() => ({ text: "x" }));
		const llm = service(gateway, usage).forStage("open_coding");
		await llm.complete({ skill: "open_coding", prompt: "p", labels: { review: 1 } });
		await llm.complete({ skill: "open_coding", prompt: "p" });
		await usage.flush();
		expect(usage.snapshot()).toMatchObject({ calls: 2, usage: { total: 30 } });
		const summary = await summarizeUsage(join(dir, "usage.jsonl"));
		expect(summary).toContain("Total LLM calls: 2");
		expect(summary).toContain("prompt_tokens=20");
		expect(summary).toContain("open_coding: calls=2");
		expect(await summarizeUsage(join(dir, "none.jsonl"))).toBe("No LLM usage recorded.");
	});

	it("validates model references", () => {
		const llm = service(new ScriptedGateway(() => ({})));
		expect(llm.validateModels(["current", "a/b", "a/b"])).toEqual(["test/current", "a/b"]);
		expect(() => llm.validateModels(["missing/x"])).toThrow("Unknown model");
	});
});

describe("isTransientMessage", () => {
	it.each([
		["429 Too Many Requests", true],
		["503 Service Unavailable", true],
		["Request timed out", true],
		["fetch failed", true],
		["Invalid API key", false],
		["context length exceeded", false],
		["HTTP 502 Bad Gateway", true],
		["Provider error status: 500", true],
		["Connection reset by peer", true],
		["400 prompt is 590 tokens over the 512 limit", false],
		["Invalid connection settings for model", false],
		["model returned 529 tokens", false],
		["error: 529 overloaded", true],
	])("%s", (message, expected) => {
		expect(isTransientMessage(message)).toBe(expected);
	});
});
