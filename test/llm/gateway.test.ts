import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ModelResolutionError, PiModelGateway } from "../../src/llm/gateway.ts";

interface Captured {
	model: { provider: string; id: string };
	context: { systemPrompt?: string; messages: Array<{ role: string; content: string }> };
	options: { temperature?: number; maxTokens?: number; onPayload?: (p: unknown) => unknown };
}

function fakeRegistry(reply: Record<string, unknown>, captured: Captured[] = []): ModelRegistry {
	const models = [
		{ provider: "openrouter", id: "google/gemma-4", api: "openai-completions" },
		{ provider: "anthropic", id: "claude", api: "anthropic-messages" },
	];
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getAvailable: () => models,
		streamSimple: (model: Captured["model"], context: Captured["context"], options: Captured["options"]) => {
			captured.push({ model, context, options });
			return { result: async () => reply };
		},
	} as unknown as ModelRegistry;
}

const assistant = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "hidden" },
		{ type: "text", text: "Hello " },
		{ type: "text", text: "world" },
	],
	stopReason: "stop",
	usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.25 } },
};

describe("PiModelGateway", () => {
	it("resolves provider/model refs, including ids containing slashes", () => {
		const gateway = new PiModelGateway(fakeRegistry(assistant), undefined);
		expect(gateway.describe("openrouter/google/gemma-4")).toBe("openrouter/google/gemma-4");
	});

	it("explains unknown models and a missing session model", () => {
		const gateway = new PiModelGateway(fakeRegistry(assistant), undefined);
		expect(() => gateway.describe("nope/x")).toThrow(ModelResolutionError);
		expect(() => gateway.describe("nope/x")).toThrow(/openrouter\/google\/gemma-4/);
		expect(() => gateway.describe("current")).toThrow(/No session model/);
		expect(() => gateway.describe("noslash")).toThrow(/provider\/model-id/);
	});

	it("uses the session model for `current`", () => {
		const current = { provider: "anthropic", id: "claude", api: "anthropic-messages" };
		const gateway = new PiModelGateway(fakeRegistry(assistant), current as never);
		expect(gateway.describe("current")).toBe("anthropic/claude");
	});

	it("streams through pi with system prompt, sampling options, and payload decoration", async () => {
		const captured: Captured[] = [];
		const gateway = new PiModelGateway(fakeRegistry(assistant, captured), undefined);
		const response = await gateway.complete("openrouter/google/gemma-4", {
			system: "SYS",
			prompt: "PROMPT",
			maxTokens: 123,
			temperature: 0,
			jsonSchema: { name: "x", schema: { type: "object" } },
			extraBody: { top_k: 1 },
		});
		expect(response).toEqual({
			text: "Hello world",
			stopReason: "stop",
			errorMessage: undefined,
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, cost: 0.25 },
			model: "openrouter/google/gemma-4",
		});
		const call = captured[0]!;
		expect(call.context.systemPrompt).toBe("SYS");
		expect(call.context.messages[0]).toMatchObject({ role: "user", content: "PROMPT" });
		expect(call.options).toMatchObject({ temperature: 0, maxTokens: 123 });
		expect(call.options.onPayload!({ model: "m" })).toMatchObject({
			top_k: 1,
			response_format: { type: "json_schema" },
		});
	});

	it("omits the system prompt when empty and passes provider errors through", async () => {
		const captured: Captured[] = [];
		const gateway = new PiModelGateway(
			fakeRegistry(
				{ content: [], stopReason: "error", errorMessage: "429 rate limited", usage: undefined },
				captured,
			),
			undefined,
		);
		const response = await gateway.complete("anthropic/claude", {
			system: "",
			prompt: "p",
			maxTokens: 1,
			temperature: 0,
		});
		expect(captured[0]!.context.systemPrompt).toBeUndefined();
		expect(response).toMatchObject({
			stopReason: "error",
			errorMessage: "429 rate limited",
			usage: { total: 0, cost: 0 },
		});
		expect(captured[0]!.options.onPayload!({ a: 1 })).toBeUndefined();
	});
});
