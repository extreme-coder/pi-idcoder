import type { GatewayRequest, GatewayResponse, ModelGateway } from "../../src/llm/gateway.ts";
import type { LlmClient, LlmRequest, LlmResponse, TokenUsage } from "../../src/llm/types.ts";

export const ONE_CALL_USAGE: TokenUsage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.001 };

export type ScriptedReply = string | Error | ((request: LlmRequest) => string | Promise<string>);

/**
 * Deterministic LlmClient for stage tests. Replies are looked up by skill key; a function reply
 * receives the full request so tests can answer based on prompt content.
 */
export class ScriptedLlm implements LlmClient {
	readonly calls: LlmRequest[] = [];
	private readonly replies: Record<string, ScriptedReply>;
	private readonly fallback: ScriptedReply | undefined;

	constructor(replies: Record<string, ScriptedReply>, fallback?: ScriptedReply) {
		this.replies = replies;
		this.fallback = fallback;
	}

	callsFor(skill: string): LlmRequest[] {
		return this.calls.filter((c) => c.skill === skill);
	}

	async complete(request: LlmRequest): Promise<LlmResponse> {
		this.calls.push(request);
		const reply = this.replies[request.skill] ?? this.fallback;
		if (reply === undefined) throw new Error(`ScriptedLlm: no reply for skill "${request.skill}"`);
		if (reply instanceof Error) throw reply;
		const text = typeof reply === "function" ? await reply(request) : reply;
		return { text, model: request.model ?? "test/model", usage: ONE_CALL_USAGE, latencyMs: 1 };
	}
}

export type GatewayHandler = (
	ref: string,
	request: GatewayRequest,
	call: number,
) => Partial<GatewayResponse> | Promise<Partial<GatewayResponse>>;

export class ScriptedGateway implements ModelGateway {
	readonly calls: Array<{ ref: string; request: GatewayRequest }> = [];
	private readonly handler: GatewayHandler;

	constructor(handler: GatewayHandler) {
		this.handler = handler;
	}

	describe(ref: string): string {
		if (ref.startsWith("missing")) throw new Error(`Unknown model "${ref}"`);
		return ref === "current" ? "test/current" : ref;
	}

	async complete(ref: string, request: GatewayRequest): Promise<GatewayResponse> {
		this.calls.push({ ref, request });
		const partial = await this.handler(ref, request, this.calls.length);
		return {
			text: "",
			stopReason: "stop",
			usage: ONE_CALL_USAGE,
			model: this.describe(ref),
			...partial,
		};
	}
}
