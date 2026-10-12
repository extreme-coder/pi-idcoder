import { readdir } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeConfigTemplate } from "../config/load.ts";
import { fileExists } from "../core/fs.ts";
import { summarizeUsage } from "../llm/usage.ts";
import { ArgsError, completeArgs, type ParsedCommand, parseCommand } from "./args.ts";
import type { IdcoderController } from "./controller.ts";
import { formatEvaluation, formatRunResult, nextStep, stageLines } from "./format.ts";
import { progressMirror } from "./tools.ts";

export const HELP = `ID-Coder — inductive-deductive qualitative coding (paper: ID-Coder, Fig. 1)

/idcoder init                 create .idcoder/config.json for a corpus and research question
/idcoder run [--from S] [--until S] [--config P]
                              run or resume the inductive pipeline (pauses for codebook review)
/idcoder status               stage-by-stage status and the next step
/idcoder review               review the codebook in the terminal (rename, merge, split, move, drop, flag)
/idcoder viewer               open the Graph Builder viewer in the browser
/idcoder evaluate [--steps recode,agreement,disagreements,judge,summary]
                              deductive recoding, Krippendorff's alpha, LLM judges, summary
/idcoder judge [annotator]    blind human judging of inductive/deductive disagreements
/idcoder usage                LLM calls, tokens, and cost by stage, skill, and model`;

function post(pi: ExtensionAPI, content: string, details?: unknown): void {
	pi.sendMessage({ customType: "idcoder", content, display: true, ...(details !== undefined ? { details } : {}) });
}

async function csvCandidates(cwd: string): Promise<string[]> {
	const found: string[] = [];
	for (const dir of [".", "data"]) {
		try {
			for (const name of await readdir(`${cwd}/${dir}`)) {
				if (/\.(csv|tsv|jsonl|ndjson|txt)$/i.test(name)) found.push(dir === "." ? name : `${dir}/${name}`);
			}
		} catch {
			// directory absent
		}
	}
	return found.slice(0, 20);
}

async function init(
	ctx: ExtensionCommandContext,
	controller: IdcoderController,
	parsed: ParsedCommand,
): Promise<string> {
	const path = controller.configPath(ctx.cwd, parsed.config);
	if ((await fileExists(path)) && !(await ctx.ui.confirm("Overwrite config?", `${path} already exists.`)))
		return "Kept the existing config.";
	const researchQuestion = await ctx.ui.input(
		"Research question",
		"What thematic patterns emerge across these texts?",
	);
	if (!researchQuestion?.trim()) return "Init cancelled.";
	const candidates = await csvCandidates(ctx.cwd);
	const other = "Other path…";
	let data = candidates.length ? await ctx.ui.select("Corpus file", [...candidates, other]) : other;
	if (data === other)
		data = await ctx.ui.input("Corpus path (CSV with text_review / review_text / text column, JSONL, or TXT)");
	if (!data?.trim()) return "Init cancelled.";
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const coder =
		current && (await ctx.ui.confirm("Coding model", `Use the current model ${current} for coding?`))
			? current
			: "current";
	const config = await writeConfigTemplate(path, {
		researchQuestion: researchQuestion.trim(),
		data: data.trim(),
		coder,
	});
	return [
		`Wrote ${path}.`,
		`Embeddings: ${config.embeddings.provider} ${config.embeddings.model} (key from $${config.embeddings.apiKeyEnv}); edit the config for local or other providers.`,
		"Add models.deductive and models.judges for evaluation, then run /idcoder run.",
	].join("\n");
}

export function registerCommands(pi: ExtensionAPI, controller: IdcoderController): void {
	pi.registerCommand("idcoder", {
		description: "ID-Coder qualitative coding: init, run, status, review, viewer, evaluate, judge, usage",
		getArgumentCompletions: (prefix) => completeArgs(prefix),
		handler: async (args, ctx) => {
			let parsed: ParsedCommand;
			try {
				parsed = parseCommand(args);
			} catch (error) {
				if (error instanceof ArgsError) return ctx.ui.notify(error.message, "error");
				throw error;
			}
			const needsUi = ["init", "review", "judge"].includes(parsed.sub);
			if (needsUi && ctx.mode !== "tui") {
				return ctx.ui.notify(`/idcoder ${parsed.sub} needs the interactive terminal UI.`, "error");
			}
			try {
				await dispatch(pi, controller, ctx, parsed);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function runAndReport(
	pi: ExtensionAPI,
	controller: IdcoderController,
	ctx: ExtensionCommandContext,
	parsed: ParsedCommand,
): Promise<void> {
	const mirror = progressMirror(ctx);
	try {
		const { session, result } = await controller.run(ctx, {
			configPath: parsed.config,
			from: parsed.from,
			until: parsed.until,
			onEvent: mirror.onEvent,
		});
		post(pi, formatRunResult(result, session.slug, session.paths.root), { status: result.status });
		const level = result.status === "failed" ? "error" : result.status === "completed" ? "info" : "warning";
		ctx.ui.notify(`ID-Coder: ${result.status}`, level);
	} finally {
		mirror.clear();
	}
}

async function dispatch(
	pi: ExtensionAPI,
	controller: IdcoderController,
	ctx: ExtensionCommandContext,
	parsed: ParsedCommand,
): Promise<void> {
	switch (parsed.sub) {
		case "help":
			return post(pi, HELP);
		case "init":
			return ctx.ui.notify(await init(ctx, controller, parsed), "info");
		case "run":
			return runAndReport(pi, controller, ctx, parsed);
		case "status": {
			const { session, state } = await controller.state(ctx, parsed.config);
			return post(
				pi,
				[`Study "${session.slug}" — ${state.researchQuestion}`, "", ...stageLines(state), "", nextStep(state)].join(
					"\n",
				),
			);
		}
		case "review": {
			const outcome = await controller.reviewInteractively(ctx, parsed.config);
			ctx.ui.notify(outcome.message, outcome.approved ? "info" : "warning");
			if (
				outcome.approved &&
				(await ctx.ui.confirm("Continue the pipeline?", "Resume with refinement and the remaining stages now?"))
			) {
				await runAndReport(pi, controller, ctx, parsed);
			}
			return;
		}
		case "viewer":
			return ctx.ui.notify(`Graph Builder viewer: ${await controller.openViewer(ctx, parsed.config)}`, "info");
		case "evaluate": {
			const outcome = await controller.evaluate(ctx, {
				configPath: parsed.config,
				steps: parsed.steps,
				onEvent: (event) =>
					ctx.ui.setStatus(
						"idcoder",
						event.type === "progress"
							? `idcoder: ${event.step} ${event.done}/${event.total}`
							: `idcoder: ${event.step}`,
					),
			});
			ctx.ui.setStatus("idcoder", undefined);
			return post(pi, formatEvaluation(outcome), { summary: outcome.summary });
		}
		case "judge": {
			const annotator = parsed.positional[0] ?? (await ctx.ui.input("Annotator id", "e.g. your initials"))?.trim();
			if (!annotator) return ctx.ui.notify("Judging needs an annotator id.", "warning");
			return ctx.ui.notify(await controller.judge(ctx, annotator, parsed.config), "info");
		}
		case "usage": {
			const { session } = await controller.state(ctx, parsed.config);
			return post(pi, await summarizeUsage(session.paths.usage));
		}
	}
}
