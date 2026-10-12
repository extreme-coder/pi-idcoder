import { type EvaluationStep, isEvaluationStep } from "../evaluation/runner.ts";
import { isStageId, STAGE_IDS, type StageId } from "../pipeline/stage.ts";

export const SUBCOMMANDS = ["init", "run", "status", "review", "viewer", "evaluate", "judge", "usage", "help"] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export interface ParsedCommand {
	sub: Subcommand;
	positional: string[];
	from?: StageId;
	until?: StageId;
	config?: string;
	steps?: EvaluationStep[];
}

export class ArgsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArgsError";
	}
}

/** Splits on whitespace, honouring single and double quotes. */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	for (const match of input.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
		tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? match[3]!));
	}
	return tokens;
}

/** `/idcoder <sub> [--from stage] [--until stage] [--config path] [--steps a,b] [args…]` */
export function parseCommand(input: string): ParsedCommand {
	const tokens = tokenize(input);
	const first = tokens[0] ?? "help";
	if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
		throw new ArgsError(`Unknown subcommand "${first}". Try: ${SUBCOMMANDS.join(", ")}.`);
	}
	const parsed: ParsedCommand = { sub: first as Subcommand, positional: [] };
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i]!;
		const value = () => {
			const next = tokens[++i];
			if (next === undefined) throw new ArgsError(`${token} needs a value.`);
			return next;
		};
		if (token === "--from" || token === "--until") {
			const stage = value();
			if (!isStageId(stage)) throw new ArgsError(`Unknown stage "${stage}". Stages: ${STAGE_IDS.join(", ")}.`);
			parsed[token === "--from" ? "from" : "until"] = stage;
		} else if (token === "--config") {
			parsed.config = value();
		} else if (token === "--steps") {
			const steps = value()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const bad = steps.filter((s) => !isEvaluationStep(s));
			if (bad.length) throw new ArgsError(`Unknown evaluation step(s): ${bad.join(", ")}.`);
			parsed.steps = steps as EvaluationStep[];
		} else if (token.startsWith("--")) {
			throw new ArgsError(`Unknown option ${token}.`);
		} else {
			parsed.positional.push(token);
		}
	}
	return parsed;
}

/** Completions for the command line after `/idcoder `. */
export function completeArgs(prefix: string): Array<{ value: string; label: string }> | null {
	const tokens = prefix.split(/\s+/);
	const current = tokens.at(-1) ?? "";
	const previous = tokens.at(-2);
	const head = tokens.slice(0, -1).join(" ");
	const withHead = (value: string) => (head ? `${head} ${value}` : value);
	let options: string[];
	if (tokens.length <= 1) options = [...SUBCOMMANDS];
	else if (previous === "--from" || previous === "--until") options = [...STAGE_IDS];
	else if (tokens[0] === "run") options = ["--from", "--until", "--config"];
	else if (tokens[0] === "evaluate") options = ["--steps", "--config"];
	else options = ["--config"];
	const matches = options.filter((o) => o.startsWith(current));
	return matches.length ? matches.map((o) => ({ value: withHead(o), label: o })) : null;
}
