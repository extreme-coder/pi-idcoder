import type { ModelsConfig } from "../config/schema.ts";
import { AbortedError, sleep } from "../core/concurrency.ts";
import type { Logger } from "../core/logger.ts";
import type { ModelGateway } from "./gateway.ts";
import type { SkillLibrary } from "./skills.ts";
import {
	isTransientMessage,
	type LlmClient,
	LlmError,
	type LlmRequest,
	type LlmResponse,
	type ModelRole,
} from "./types.ts";
import type { UsageRecorder } from "./usage.ts";

export interface LlmServiceDeps {
	gateway: ModelGateway;
	models: ModelsConfig;
	skills: SkillLibrary;
	usage: UsageRecorder;
	logger: Logger;
	/** Base delay for exponential backoff; tests set it to 0. */
	retryBaseMs?: number;
}

export function modelRefForRole(models: ModelsConfig, role: ModelRole): string {
	return models[role] ?? models.coder;
}

/** Every pipeline LLM call goes through here: skill system prompts, retries, and usage accounting. */
export class LlmService implements LlmClient {
	private readonly deps: LlmServiceDeps;
	private readonly stage: string | null;

	constructor(deps: LlmServiceDeps, stage: string | null = null) {
		this.deps = deps;
		this.stage = stage;
	}

	forStage(stage: string): LlmService {
		return new LlmService(this.deps, stage);
	}

	/** Resolves every configured model, so a typo fails before any work is done. */
	validateModels(refs: Iterable<string>): string[] {
		return [...new Set(refs)].map((ref) => this.deps.gateway.describe(ref));
	}

	async complete(request: LlmRequest): Promise<LlmResponse> {
		const { gateway, models, skills, usage, logger } = this.deps;
		const ref = request.model ?? modelRefForRole(models, request.role ?? "coder");
		const system = request.system ?? (await skills.systemPrompt(request.skill));
		const maxAttempts = models.maxRetries + 1;
		const baseMs = this.deps.retryBaseMs ?? 1000;

		for (let attempt = 1; ; attempt++) {
			if (request.signal?.aborted) throw new AbortedError();
			const started = performance.now();
			let failure: LlmError;
			try {
				const response = await gateway.complete(ref, {
					system,
					prompt: request.prompt,
					maxTokens: request.maxTokens ?? models.maxTokens,
					temperature: request.temperature ?? models.temperature,
					jsonSchema: request.jsonSchema,
					extraBody: models.extraBody,
					signal: request.signal,
				});
				const latencyMs = performance.now() - started;
				usage.record({
					stage: this.stage,
					skill: request.skill,
					model: response.model,
					usage: response.usage,
					latencyMs,
					labels: request.labels,
				});
				if (response.stopReason === "aborted") throw new AbortedError();
				if (response.stopReason !== "error") {
					if (response.stopReason === "length") {
						logger.warn("LLM_TRUNCATED", `skill=${request.skill} model=${response.model}`);
					}
					return { text: response.text.trim(), model: response.model, usage: response.usage, latencyMs };
				}
				const message = response.errorMessage ?? "unknown provider error";
				failure = new LlmError(message, isTransientMessage(message));
			} catch (error) {
				if (error instanceof AbortedError || request.signal?.aborted) throw new AbortedError();
				if (error instanceof LlmError) failure = error;
				else {
					const message = error instanceof Error ? error.message : String(error);
					failure = new LlmError(message, isTransientMessage(message));
				}
			}
			if (!failure.retryable || attempt >= maxAttempts) throw failure;
			const delay = Math.min(30_000, baseMs * 2 ** (attempt - 1));
			logger.warn(
				"LLM_RETRY",
				`skill=${request.skill} attempt ${attempt}/${maxAttempts} in ${delay}ms: ${failure.message}`,
			);
			await sleep(delay, request.signal);
		}
	}
}
