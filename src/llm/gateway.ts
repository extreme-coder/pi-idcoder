import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../core/json.ts";
import type { JsonSchemaHint, TokenUsage } from "./types.ts";

export interface GatewayRequest {
	system: string;
	prompt: string;
	maxTokens: number;
	temperature: number;
	jsonSchema?: JsonSchemaHint | undefined;
	extraBody?: Record<string, unknown> | undefined;
	signal?: AbortSignal | undefined;
}

export interface GatewayResponse {
	text: string;
	stopReason: string;
	errorMessage?: string | undefined;
	usage: TokenUsage;
	model: string;
}

/** The slice of pi's model runtime the pipeline needs; tests substitute a scripted implementation. */
export interface ModelGateway {
	/** Validates a model reference up front so misconfiguration fails before a long run starts. */
	describe(ref: string): string;
	complete(ref: string, request: GatewayRequest): Promise<GatewayResponse>;
}

export class ModelResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelResolutionError";
	}
}

export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Adds JSON-schema output constraints and extra body fields to OpenAI-style payloads. */
export function decoratePayload(
	api: string,
	payload: unknown,
	jsonSchema: JsonSchemaHint | undefined,
	extraBody: Record<string, unknown> | undefined,
): unknown {
	if (!isRecord(payload)) return undefined;
	if (api === "openai-completions") {
		return {
			...payload,
			...(extraBody ?? {}),
			...(jsonSchema
				? {
						response_format: {
							type: "json_schema",
							json_schema: { name: jsonSchema.name, schema: jsonSchema.schema },
						},
					}
				: {}),
		};
	}
	if ((api === "openai-responses" || api === "azure-openai-responses") && jsonSchema) {
		const text = isRecord(payload.text) ? payload.text : {};
		return {
			...payload,
			text: { ...text, format: { type: "json_schema", name: jsonSchema.name, schema: jsonSchema.schema } },
		};
	}
	return undefined;
}

function usageOf(message: AssistantMessage): TokenUsage {
	const u = message.usage;
	return {
		input: u?.input ?? 0,
		output: u?.output ?? 0,
		cacheRead: u?.cacheRead ?? 0,
		cacheWrite: u?.cacheWrite ?? 0,
		total: u?.totalTokens ?? (u?.input ?? 0) + (u?.output ?? 0),
		cost: u?.cost?.total ?? 0,
	};
}

export class PiModelGateway implements ModelGateway {
	private readonly registry: ModelRegistry;
	private readonly current: Model<Api> | undefined;
	/** pi's session id; providers such as OpenCode Go route on it and reject calls without it. */
	private readonly sessionId: string | undefined;

	constructor(registry: ModelRegistry, current: Model<Api> | undefined, sessionId?: string) {
		this.registry = registry;
		this.current = current;
		this.sessionId = sessionId;
	}

	private resolve(ref: string): Model<Api> {
		if (ref === "current") {
			if (!this.current) {
				throw new ModelResolutionError('No session model is selected; set models.coder to "provider/model-id".');
			}
			return this.current;
		}
		const parts = splitModelRef(ref);
		const model = parts ? this.registry.find(parts.provider, parts.id) : undefined;
		if (!model) {
			const available = this.registry
				.getAvailable()
				.slice(0, 12)
				.map((m) => `${m.provider}/${m.id}`);
			throw new ModelResolutionError(
				`Unknown model "${ref}". Use "provider/model-id"${available.length ? `, e.g. ${available.join(", ")}` : ""}.`,
			);
		}
		return model;
	}

	describe(ref: string): string {
		const model = this.resolve(ref);
		return `${model.provider}/${model.id}`;
	}

	async complete(ref: string, request: GatewayRequest): Promise<GatewayResponse> {
		const model = this.resolve(ref);
		const context: Context = {
			...(request.system ? { systemPrompt: request.system } : {}),
			messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
		};
		const message = await this.registry
			.streamSimple(model, context, {
				signal: request.signal,
				temperature: request.temperature,
				maxTokens: request.maxTokens,
				sessionId: this.sessionId,
				onPayload: (payload) => decoratePayload(model.api, payload, request.jsonSchema, request.extraBody),
			})
			.result();
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("");
		return {
			text,
			stopReason: message.stopReason,
			errorMessage: message.errorMessage,
			usage: usageOf(message),
			model: `${model.provider}/${model.id}`,
		};
	}
}
