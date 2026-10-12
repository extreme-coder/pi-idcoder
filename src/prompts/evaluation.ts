import type { DetailLevel } from "../config/schema.ts";

/**
 * Prompts for deductive recoding (paper §3.2) and blind disagreement judging (§3.3), ported from
 * evaluation/prompts_reclassify.py and judge_reclassify_disagreements/prompts_judge.py. The wording
 * only claims the codebook parts actually shown for the detail level; claiming criteria that were
 * not provided made some models refuse to classify.
 */

const BASIS_TEXT: Record<DetailLevel, string> = {
	theme_only: "the category LABEL",
	theme_def: "the category LABEL and DEFINITION",
	full: "the written LABEL, DEFINITION, and INCLUSION/EXCLUSION criteria",
};

export function recodeSystemPrompt(level: DetailLevel, includeReasoning: boolean): string {
	const reasoningLine = includeReasoning
		? "\nWrite the reasoning field in plain, conversational language -- avoid academic jargon and noun-heavy phrasing."
		: "";
	return `You are a qualitative coding expert applying an existing codebook to raw data.
You will be given a set of meta-theme categories and a batch of raw quotes from participant reviews. For EACH quote, classify it into exactly ONE of the meta-theme categories based ONLY on ${BASIS_TEXT[level]} -- do not guess based on what a "typical" categorization might look like, and do not assume any information beyond what is actually given below.
If a quote genuinely does not fit any category based on the information given, you may respond "NONE" for that quote rather than forcing a fit.${reasoningLine}`;
}

export function recodeUserPrompt(
	codebookText: string,
	quotesText: string,
	level: DetailLevel,
	includeReasoning: boolean,
): string {
	const schemaLines = includeReasoning
		? `    {"quote_index": 1, "meta_theme": "<letter or NONE>", "reasoning": "<one sentence>"},
    {"quote_index": 2, "meta_theme": "<letter or NONE>", "reasoning": "<one sentence>"},
    ...`
		: `    {"quote_index": 1, "meta_theme": "<letter or NONE>"},
    {"quote_index": 2, "meta_theme": "<letter or NONE>"},
    ...`;
	return `META-THEME CATEGORIES:

${codebookText}

---
QUOTES TO CLASSIFY:

${quotesText}

---
For EACH quote above, decide which meta-theme category (by its letter, e.g. "A") it belongs to based on ${BASIS_TEXT[level]}, or "NONE" if it genuinely fits no category.

Respond in JSON, one entry per quote index:
{
  "classifications": [
${schemaLines}
  ]
}`;
}

export interface JudgeOption {
	label: string;
	definition: string;
	inclusion: string[];
	exclusion: string[];
}

export interface JudgePromptItem {
	quote: string;
	optionA: JudgeOption;
	optionB: JudgeOption;
}

export type JudgeOutcomes = "binary" | "four_way";

const BINARY_SYSTEM = `You are a qualitative research expert judging, quote by quote, which of two candidate themes a participant review quote fits better. Each candidate is defined by a label, a definition, and inclusion/exclusion criteria written by a separate process -- you are not told where either candidate came from, or which one (if either) was the "original" categorization. For EACH quote in the batch, pick whichever candidate -- Option A or Option B -- the quote fits better, based only on the written definition and criteria. You must pick one; there is no "neither" option here.`;

const FOUR_WAY_SYSTEM = `You are a qualitative research expert judging, quote by quote, how a participant review quote relates to two candidate themes. Each candidate is defined by a label, a definition, and inclusion/exclusion criteria written by a separate process -- you are not told where either candidate came from, or which one (if either) was the "original" categorization. For EACH quote in the batch, based only on the written definitions and criteria, answer:
- "A" if the quote fits Option A better,
- "B" if the quote fits Option B better,
- "BOTH" if the quote fits both options equally well and they cannot be distinguished for this quote,
- "NEITHER" if the quote fits neither option.`;

export function judgeSystemPrompt(outcomes: JudgeOutcomes): string {
	return outcomes === "binary" ? BINARY_SYSTEM : FOUR_WAY_SYSTEM;
}

function formatOption(option: JudgeOption): string {
	const lines = [`    LABEL: ${option.label}`, `    DEFINITION: ${option.definition}`];
	if (option.inclusion.length) {
		lines.push("    INCLUSION CRITERIA:", ...option.inclusion.map((c) => `      - ${c}`));
	}
	if (option.exclusion.length) {
		lines.push("    EXCLUSION CRITERIA:", ...option.exclusion.map((c) => `      - ${c}`));
	}
	return lines.join("\n");
}

export function formatJudgeItem(index: number, item: JudgePromptItem): string {
	return `${index}. QUOTE: "${item.quote}"
  Option A:
${formatOption(item.optionA)}
  Option B:
${formatOption(item.optionB)}`;
}

export function judgeUserPrompt(items: readonly JudgePromptItem[], outcomes: JudgeOutcomes): string {
	const itemsText = items.map((item, i) => formatJudgeItem(i + 1, item)).join("\n\n");
	const question =
		outcomes === "binary"
			? "For EACH question above, decide whether the quote fits Option A or Option B better."
			: 'For EACH question above, answer "A", "B", "BOTH", or "NEITHER".';
	const examples =
		outcomes === "binary"
			? `    {"item_index": 1, "pick": "A"},
    {"item_index": 2, "pick": "B"},`
			: `    {"item_index": 1, "pick": "A"},
    {"item_index": 2, "pick": "NEITHER"},`;
	return `Below are ${items.length} independent quote-judging questions. Each has a quote and two candidate themes (Option A / Option B), each with its own label, definition, and inclusion/exclusion criteria.

${itemsText}

---
${question}

Respond in JSON, one entry per question index:
{
  "verdicts": [
${examples}
    ...
  ]
}`;
}
