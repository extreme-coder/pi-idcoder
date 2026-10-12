import { matchesKey } from "@earendil-works/pi-tui";
import type { DisagreementItem, JudgeOptionText, Verdict } from "../evaluation/types.ts";
import type { JudgeOutcomes } from "../prompts/evaluation.ts";
import { rule, type Styler, wrap } from "./styler.ts";

export type JudgeKeyResult =
	| { kind: "verdict"; verdict: Verdict }
	| { kind: "skip" }
	| { kind: "quit" }
	| { kind: "none" };

/** 1/a → A, 2/b → B, 3/t → both fit, 4/n → neither (four-way only), s skip, esc/q quit. */
export function judgeKey(data: string, outcomes: JudgeOutcomes): JudgeKeyResult {
	if (matchesKey(data, "escape") || matchesKey(data, "q")) return { kind: "quit" };
	if (matchesKey(data, "s")) return { kind: "skip" };
	if (matchesKey(data, "1") || matchesKey(data, "a")) return { kind: "verdict", verdict: "A" };
	if (matchesKey(data, "2") || matchesKey(data, "b")) return { kind: "verdict", verdict: "B" };
	if (outcomes === "four_way") {
		if (matchesKey(data, "3") || matchesKey(data, "t")) return { kind: "verdict", verdict: "BOTH" };
		if (matchesKey(data, "4") || matchesKey(data, "n")) return { kind: "verdict", verdict: "NEITHER" };
	}
	return { kind: "none" };
}

function optionLines(name: string, option: JudgeOptionText, width: number, styler: Styler): string[] {
	const lines = wrap(styler.bold(styler.fg("accent", `${name}: ${option.label}`)), width);
	if (option.definition) lines.push(...wrap(option.definition, width, "  "));
	for (const c of option.inclusion) lines.push(...wrap(styler.fg("success", `+ ${c}`), width, "  "));
	for (const c of option.exclusion) lines.push(...wrap(styler.fg("warning", `− ${c}`), width, "  "));
	return lines;
}

/** Blind judging screen: never reveals which option is the inductive theme. */
export function renderJudgeItem(
	item: DisagreementItem,
	position: { index: number; total: number; annotator: string },
	outcomes: JudgeOutcomes,
	width: number,
	styler: Styler,
): string[] {
	const keys =
		outcomes === "four_way"
			? "1 Option A · 2 Option B · 3 both fit · 4 neither fits · s skip · esc stop"
			: "1 Option A · 2 Option B · s skip · esc stop";
	return [
		rule(styler, width, `Judge ${position.index + 1}/${position.total} · ${position.annotator}`),
		...wrap(styler.bold(`“${item.quote}”`), width, "  "),
		"",
		...optionLines("Option A", item.option_a, width, styler),
		"",
		...optionLines("Option B", item.option_b, width, styler),
		rule(styler, width),
		...wrap(styler.fg("dim", `Which theme does the quote fit better? ${keys}`), width),
	];
}
