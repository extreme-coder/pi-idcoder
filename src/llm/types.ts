export type ModelRole = "coder" | "validator" | "clustering" | "enrichment" | "report";

export interface JsonSchemaHint {
	name: string;
	schema: Record<string, unknown>;
}

export interface LlmRequest {
	/** Skill key: selects the bundled system prompt and labels usage records. */
	skill: string;
	prompt: string;
	/** Replaces the skill system prompt (HICode clustering sends its own). */
	system?: string;
	role?: ModelRole;
	/** Explicit `provider/model` reference; overrides `role` (deductive agents, judges). */
	model?: string;
	maxTokens?: number;
	temperature?: number;
	/** Requests schema-constrained output where the provider API supports it; responses are still validated. */
	jsonSchema?: JsonSchemaHint;
	labels?: Record<string, string | number | boolean | null>;
	signal?: AbortSignal;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export interface LlmResponse {
	text: string;
	model: string;
	usage: TokenUsage;
	latencyMs: number;
}

export interface LlmClient {
	complete(request: LlmRequest): Promise<LlmResponse>;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	cost: 0,
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		total: a.total + b.total,
		cost: a.cost + b.cost,
	};
}

export class LlmError extends Error {
	readonly retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "LlmError";
		this.retryable = retryable;
	}
}

const TRANSIENT =
	/\b(429|5\d\d)\b|rate.?limit|overloaded|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection|temporar|unavailable|fetch failed/i;

export function isTransientMessage(message: string): boolean {
	return TRANSIENT.test(message);
}
