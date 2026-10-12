import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EVALUATION_STEPS } from "../evaluation/runner.ts";
import type { TokenUsage } from "../llm/types.ts";
import type { RunEvent } from "../pipeline/runner.ts";
import { STAGE_IDS } from "../pipeline/stage.ts";
import type { IdcoderController } from "./controller.ts";
import { formatEvaluation, formatRunResult, nextStep, ProgressView, stageLines } from "./format.ts";
import { INSPECT_TARGETS, inspectRun } from "./inspect.ts";

export function toPiUsage(usage: TokenUsage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.total,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

const text = (value: string) => [{ type: "text" as const, text: value }];

const configParam = Type.Optional(
	Type.String({ description: "Path to the idcoder config; defaults to .idcoder/config.json in the project." }),
);

/** Mirrors pipeline progress into pi's status bar and a widget while a tool or command runs. */
export function progressMirror(
	ctx: ExtensionContext,
	onLines?: (lines: string[]) => void,
): {
	onEvent: (event: RunEvent) => void;
	clear: () => void;
} {
	const view = new ProgressView();
	return {
		onEvent: (event) => {
			view.apply(event);
			if (ctx.hasUI) {
				ctx.ui.setStatus("idcoder", view.statusText());
				ctx.ui.setWidget("idcoder", view.lines());
			}
			onLines?.(view.lines());
		},
		clear: () => {
			if (!ctx.hasUI) return;
			ctx.ui.setStatus("idcoder", undefined);
			ctx.ui.setWidget("idcoder", undefined);
		},
	};
}

export function registerTools(pi: ExtensionAPI, controller: IdcoderController): void {
	pi.registerTool({
		name: "idcoder_run",
		label: "ID-Coder run",
		description:
			"Run or resume the ID-Coder inductive qualitative coding pipeline (open coding, clustering, labeling, human codebook review, refinement, enrichment, hierarchy, meta-themes, report). Resumes from checkpoints; pauses at the human codebook review gate.",
		promptSnippet: "Run or resume the ID-Coder thematic analysis pipeline on the configured corpus",
		promptGuidelines: [
			"Call idcoder_status first to see where a run stands; idcoder_run resumes from the last completed stage.",
			"When idcoder_run pauses for codebook review, stop and ask the user to review with /idcoder review or /idcoder viewer. Never approve or edit a codebook on the user's behalf.",
			"Only pass `from` when the user asks to recompute a stage; it discards that stage and everything after it.",
		],
		parameters: Type.Object({
			config: configParam,
			from: Type.Optional(StringEnum(STAGE_IDS, { description: "Re-run this stage and everything after it." })),
			until: Type.Optional(StringEnum(STAGE_IDS, { description: "Stop after this stage." })),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async execute(_id, params, signal, onUpdate, ctx) {
			const mirror = progressMirror(ctx, (lines) =>
				onUpdate?.({ content: text(lines.join("\n")), details: { progress: lines } }),
			);
			try {
				const { session, result } = await controller.run(ctx, {
					configPath: params.config,
					from: params.from,
					until: params.until,
					signal,
					onEvent: mirror.onEvent,
				});
				return {
					content: text(formatRunResult(result, session.slug, session.paths.root)),
					details: { status: result.status, stages: result.state.stages, runDir: session.paths.root },
					usage: toPiUsage(session.usage.snapshot().usage),
					isError: result.status === "failed",
					terminate: result.status === "paused",
				};
			} finally {
				mirror.clear();
			}
		},
	});

	pi.registerTool({
		name: "idcoder_status",
		label: "ID-Coder status",
		description: "Show the stage-by-stage status of the ID-Coder run for the configured study and what to do next.",
		parameters: Type.Object({ config: configParam }),
		annotations: { readOnlyHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { session, state } = await controller.state(ctx, params.config);
			const body = [
				`Study "${session.slug}" — ${state.researchQuestion}`,
				"",
				...stageLines(state),
				"",
				nextStep(state),
			].join("\n");
			return { content: text(body), details: { stages: state.stages, runDir: session.paths.root } };
		},
	});

	pi.registerTool({
		name: "idcoder_evaluate",
		label: "ID-Coder evaluate",
		description:
			"Evaluate a completed ID-Coder run: deductive agents recode every quote from the codebook at each detail level, Krippendorff's alpha against the inductive agent, a blind disagreement pool, LLM judges, and a summary (including any human judgments).",
		parameters: Type.Object({
			config: configParam,
			steps: Type.Optional(
				Type.Array(StringEnum(EVALUATION_STEPS), { description: "Subset of steps to run; defaults to all." }),
			),
		}),
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		async execute(_id, params, signal, onUpdate, ctx) {
			const outcome = await controller.evaluate(ctx, {
				configPath: params.config,
				steps: params.steps,
				signal,
				onEvent: (event) => {
					const line =
						event.type === "progress"
							? `${event.step}: ${event.detail} ${event.done}/${event.total}`
							: `${event.step}: ${event.detail}`;
					onUpdate?.({ content: text(line), details: { event } });
				},
			});
			return {
				content: text(formatEvaluation(outcome)),
				details: { summary: outcome.summary, notes: outcome.notes, dir: outcome.paths.root },
			};
		},
	});

	pi.registerTool({
		name: "idcoder_inspect",
		label: "ID-Coder inspect",
		description:
			"Read results of the ID-Coder run: the codebook overview, one cluster with its definition, criteria, examples and codes, meta-themes, the research report, the evaluation summary, LLM usage, or the trace log.",
		parameters: Type.Object({
			config: configParam,
			what: StringEnum(INSPECT_TARGETS, { description: "Which view to return." }),
			cluster_id: Type.Optional(Type.String({ description: "Cluster id for what=cluster." })),
			max_chars: Type.Optional(Type.Integer({ minimum: 500, maximum: 200_000, default: 20_000 })),
		}),
		annotations: { readOnlyHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { config } = await controller.loadConfig(ctx.cwd, params.config);
			const session = controller.session(ctx, config);
			const body = await inspectRun(session, params.what, {
				...(params.cluster_id !== undefined ? { clusterId: params.cluster_id } : {}),
				maxChars: params.max_chars ?? 20_000,
			});
			return { content: text(body), details: { what: params.what } };
		},
	});
}
