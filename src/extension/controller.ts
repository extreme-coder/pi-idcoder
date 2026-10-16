import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RunPaths } from "../artifacts/paths.ts";
import { defaultConfigPath, loadConfig, resolveSlug, resolveViewerDir } from "../config/load.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { fileExists, readJson, readJsonIfExists, readJsonl, writeJson } from "../core/fs.ts";
import { createEmbedder, type Embedder } from "../embeddings/embedder.ts";
import { itemsForAnnotator, loadHumanJudgments, makeJudgment, recordJudgment } from "../evaluation/human.ts";
import {
	type EvaluationEvent,
	type EvaluationOutcome,
	type EvaluationStep,
	runEvaluation,
} from "../evaluation/runner.ts";
import { type DisagreementItem, EvalPaths } from "../evaluation/types.ts";
import type { CodeEvidenceFile } from "../evidence/code-evidence.ts";
import { type ModelGateway, PiModelGateway } from "../llm/gateway.ts";
import type { RunEvent, RunResult } from "../pipeline/runner.ts";
import { RunSession } from "../pipeline/session.ts";
import type { StageId } from "../pipeline/stage.ts";
import type { RunState } from "../pipeline/state.ts";
import { BrowserReviewGateway } from "../review/browser-gateway.ts";
import {
	FileWaitReviewGateway,
	pausingReviewGateway,
	type ReviewDecision,
	type ReviewGateway,
	type ReviewRequest,
} from "../review/gateway.ts";
import type { EnrichedCodebook } from "../review/schema.ts";
import { ReviewSession } from "../review/session.ts";
import { runJudgeFlow, runReviewFlow } from "../ui/flows.ts";
import { piUi, type UiPort } from "../ui/port.ts";
import { codebookReviewDir } from "../viewer/data.ts";
import type { ViewerHost } from "../viewer/host.ts";

export interface ControllerDeps {
	gatewayFor(ctx: ExtensionContext): ModelGateway;
	embedderFor(config: IdcoderConfig): Embedder;
	viewer: ViewerHost;
	openUrl(url: string): Promise<void>;
	/** Value of the `--idcoder-config` CLI flag, if set. */
	configFlag(): string | undefined;
	uiFor?(ctx: ExtensionContext): UiPort;
}

export function defaultControllerDeps(
	viewer: ViewerHost,
	openUrl: (url: string) => Promise<void>,
	configFlag: () => string | undefined,
): ControllerDeps {
	return {
		gatewayFor: (ctx) => new PiModelGateway(ctx.modelRegistry, ctx.model, ctx.sessionManager.getSessionId()),
		embedderFor: (config) => createEmbedder(config.embeddings),
		viewer,
		openUrl,
		configFlag,
	};
}

export class BusyError extends Error {
	constructor(slug: string) {
		super(`A run for "${slug}" is already in progress in this session.`);
		this.name = "BusyError";
	}
}

async function loadEvidence(
	config: IdcoderConfig,
	projectDir: string,
	slug: string,
): Promise<CodeEvidenceFile | undefined> {
	const path = join(codebookReviewDir(resolveViewerDir(config, projectDir), slug), "code_evidence.json");
	return readJsonIfExists<CodeEvidenceFile>(path).catch(() => undefined);
}

/** Terminal review inside pi: the gate opens the review screen in the user's session. */
export class TerminalReviewGateway implements ReviewGateway {
	private readonly ui: UiPort;
	private readonly config: IdcoderConfig;
	private readonly projectDir: string;

	constructor(ui: UiPort, config: IdcoderConfig, projectDir: string) {
		this.ui = ui;
		this.config = config;
		this.projectDir = projectDir;
	}

	async review(request: ReviewRequest): Promise<ReviewDecision> {
		const evidence = await loadEvidence(this.config, this.projectDir, request.slug);
		const result = await runReviewFlow(this.ui, new ReviewSession(request.proposal), evidence);
		if (!result.approved) {
			return {
				kind: "pending",
				message:
					"Codebook review was left without approval. Run /idcoder review when ready, then /idcoder run to continue.",
			};
		}
		return { kind: "approved", payload: result.payload, reviewId: request.slug };
	}
}

/** Session-scoped orchestration behind the tools and the /idcoder command. */
export class IdcoderController {
	private readonly deps: ControllerDeps;
	private readonly active = new Map<string, AbortController>();

	constructor(deps: ControllerDeps) {
		this.deps = deps;
	}

	configPath(cwd: string, explicit?: string): string {
		const chosen = explicit ?? this.deps.configFlag();
		if (!chosen) return defaultConfigPath(cwd);
		return isAbsolute(chosen) ? chosen : resolve(cwd, chosen);
	}

	async loadConfig(cwd: string, explicit?: string): Promise<{ config: IdcoderConfig; path: string }> {
		const path = this.configPath(cwd, explicit);
		return { config: await loadConfig(path), path };
	}

	session(ctx: ExtensionContext, config: IdcoderConfig): RunSession {
		return new RunSession({
			projectDir: ctx.cwd,
			config,
			gateway: this.deps.gatewayFor(ctx),
			embedder: this.deps.embedderFor(config),
		});
	}

	ui(ctx: ExtensionContext): UiPort {
		return this.deps.uiFor?.(ctx) ?? piUi(ctx);
	}

	/** Chooses how the human gate reaches the researcher for the current mode and config. */
	reviewGateway(ctx: ExtensionContext, config: IdcoderConfig): ReviewGateway {
		const { mode, waitForFile, timeoutSec, pollIntervalSec } = config.review;
		const interactive = ctx.mode === "tui";
		if (mode === "browser") {
			return new BrowserReviewGateway({
				host: this.deps.viewer,
				config,
				projectDir: ctx.cwd,
				openUrl: this.deps.openUrl,
				notify: (message) => (ctx.hasUI ? ctx.ui.notify(message, "info") : undefined),
			});
		}
		if ((mode === "auto" || mode === "tui") && interactive)
			return new TerminalReviewGateway(this.ui(ctx), config, ctx.cwd);
		if (waitForFile) return new FileWaitReviewGateway({ timeoutSec, pollIntervalSec });
		return pausingReviewGateway;
	}

	private begin(slug: string, external?: AbortSignal): { signal: AbortSignal; end: () => void } {
		if (this.active.has(slug)) throw new BusyError(slug);
		const controller = new AbortController();
		this.active.set(slug, controller);
		return {
			signal: external ? AbortSignal.any([controller.signal, external]) : controller.signal,
			end: () => this.active.delete(slug),
		};
	}

	isRunning(slug: string): boolean {
		return this.active.has(slug);
	}

	async run(
		ctx: ExtensionContext,
		options: {
			configPath?: string | undefined;
			from?: StageId | undefined;
			until?: StageId | undefined;
			signal?: AbortSignal | undefined;
			onEvent?: (event: RunEvent) => void;
		} = {},
	): Promise<{ session: RunSession; result: RunResult }> {
		const { config } = await this.loadConfig(ctx.cwd, options.configPath);
		const session = this.session(ctx, config);
		const { signal, end } = this.begin(session.slug, options.signal);
		try {
			const result = await session.run({
				review: this.reviewGateway(ctx, config),
				from: options.from,
				until: options.until,
				signal,
				onEvent: options.onEvent,
			});
			return { session, result };
		} finally {
			end();
		}
	}

	async evaluate(
		ctx: ExtensionContext,
		options: {
			configPath?: string | undefined;
			steps?: readonly EvaluationStep[] | undefined;
			signal?: AbortSignal | undefined;
			onEvent?: (event: EvaluationEvent) => void;
		} = {},
	): Promise<EvaluationOutcome> {
		const { config } = await this.loadConfig(ctx.cwd, options.configPath);
		const session = this.session(ctx, config);
		const { signal, end } = this.begin(session.slug, options.signal);
		try {
			return await runEvaluation(session, { steps: options.steps, signal, onEvent: options.onEvent });
		} finally {
			end();
		}
	}

	async state(ctx: ExtensionContext, configPath?: string): Promise<{ session: RunSession; state: RunState }> {
		const { config } = await this.loadConfig(ctx.cwd, configPath);
		const session = this.session(ctx, config);
		return { session, state: await session.state() };
	}

	/**
	 * Opens the staged proposal in the terminal review screen and saves an approval for the gate.
	 * Returns the session when something was approved, so the caller can resume the pipeline.
	 */
	async reviewInteractively(
		ctx: ExtensionContext,
		configPath?: string,
	): Promise<{ approved: boolean; message: string; session: RunSession }> {
		const { config } = await this.loadConfig(ctx.cwd, configPath);
		const session = this.session(ctx, config);
		if (await session.store.provenance()) {
			return {
				approved: false,
				session,
				message: "This codebook was already approved. To review again, run /idcoder run --from codebook_review.",
			};
		}
		if (!(await fileExists(session.paths.codebookV1))) {
			return {
				approved: false,
				session,
				message:
					"No codebook is waiting for review yet. Run /idcoder run; the review opens when the pipeline reaches the review stage.",
			};
		}
		const proposal = await readJson<EnrichedCodebook>(session.paths.codebookV1);
		const result = await runReviewFlow(
			this.ui(ctx),
			new ReviewSession(proposal),
			await loadEvidence(config, ctx.cwd, session.slug),
		);
		if (!result.approved) return { approved: false, session, message: "Review closed without approval." };
		await writeJson(session.paths.codebookV2, result.payload);
		return { approved: true, session, message: `Approval saved to ${session.paths.codebookV2}.` };
	}

	async openViewer(ctx: ExtensionContext, configPath?: string): Promise<string> {
		const { config } = await this.loadConfig(ctx.cwd, configPath);
		const { url } = await this.deps.viewer.open(config, ctx.cwd);
		await this.deps.openUrl(url).catch(() => {});
		return url;
	}

	/** Blind human judging of the disagreement pool for one annotator (paper §3.3, human judges). */
	async judge(ctx: ExtensionContext, annotator: string, configPath?: string): Promise<string> {
		const { config } = await this.loadConfig(ctx.cwd, configPath);
		const paths = new EvalPaths(RunPaths.forSlug(ctx.cwd, resolveSlug(config)).evaluation);
		const pool = await readJsonl<DisagreementItem>(paths.itemPool);
		if (pool.length === 0) return "No disagreement items yet. Run /idcoder evaluate first.";
		const done = new Set(
			(await loadHumanJudgments(paths)).filter((j) => j.annotator === annotator).map((j) => j.item_id),
		);
		const items = itemsForAnnotator(pool, annotator, done, config.evaluation.human.itemsPerAnnotator, config.seed);
		if (items.length === 0) return `${annotator} has judged every assigned item.`;
		const result = await runJudgeFlow(this.ui(ctx), items, {
			annotator,
			outcomes: config.evaluation.judge.outcomes,
			record: (item, verdict) => recordJudgment(paths, makeJudgment(item, annotator, verdict)),
		});
		return `${annotator}: ${result.judged} judged, ${result.skipped} skipped${result.stopped ? " (stopped early; run again to continue)" : ""}. Saved to ${paths.human(annotator)}.`;
	}

	abortAll(): void {
		for (const controller of this.active.values()) controller.abort();
	}

	async shutdown(): Promise<void> {
		this.abortAll();
		await this.deps.viewer.stop();
	}
}
