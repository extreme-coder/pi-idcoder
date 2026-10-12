import { join } from "node:path";
import type { DetailLevel } from "../config/schema.ts";

/** One (review, open code, quote) unit with the meta-theme the inductive agent assigned it. */
export interface GroundTruthRow {
	review_idx: number;
	open_code: string;
	quote: string;
	sibling_quotes: string[];
	true_meta_theme_idx: number;
	true_meta_theme_label: string;
}

export type RecodeStatus = "classified" | "call_failed";

export interface RecodeRow extends GroundTruthRow {
	pred_meta_theme_idx: number | null;
	pred_meta_theme_label: string;
	pred_letter_raw: string;
	status: RecodeStatus;
	agree: boolean | null;
	detail_level: DetailLevel;
	classifier_model: string;
	/** Fingerprint of the codebook text the agent saw; checkpoints from another codebook are ignored. */
	codebook_hash?: string;
}

export interface JudgeOptionText {
	label: string;
	definition: string;
	inclusion: string[];
	exclusion: string[];
}

/** A blind A/B question: does this quote fit the inductive theme or the deductive agent's alternative? */
export interface DisagreementItem {
	item_id: string;
	review_idx: number;
	open_code: string;
	quote: string;
	option_a: JudgeOptionText;
	option_b: JudgeOptionText;
	/** Side holding the inductive agent's theme; never shown to judges. */
	true_side: "A" | "B";
	true_label: string;
	pred_label: string;
	raised_by: string[];
}

export type Verdict = "A" | "B" | "BOTH" | "NEITHER";
export type Preference = "inductive" | "deductive" | "both" | "neither";

export interface JudgeRow {
	item_id: string;
	judge: string;
	verdict: Verdict | "";
	status: "judged" | "call_failed";
	preferred: Preference | null;
}

export interface HumanJudgment {
	item_id: string;
	annotator: string;
	verdict: Verdict;
	preferred: Preference;
	ts: string;
}

export function preferenceOf(verdict: Verdict, trueSide: "A" | "B"): Preference {
	if (verdict === "BOTH") return "both";
	if (verdict === "NEITHER") return "neither";
	return verdict === trueSide ? "inductive" : "deductive";
}

/** Filesystem-safe form of a `provider/model` reference. */
export function modelSlug(ref: string): string {
	return ref.replace(/[^A-Za-z0-9._-]+/g, "__");
}

export class EvalPaths {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	recode(model: string, level: DetailLevel): string {
		return join(this.root, "recode", modelSlug(model), level, "reclassified.jsonl");
	}
	recodeUnresolved(model: string, level: DetailLevel): string {
		return join(this.root, "recode", modelSlug(model), level, "unresolved.jsonl");
	}
	recodeCheckpoint(model: string, level: DetailLevel): string {
		return join(this.root, "recode", modelSlug(model), level, "checkpoint.jsonl");
	}
	get agreement(): string {
		return join(this.root, "agreement.json");
	}
	get itemPool(): string {
		return join(this.root, "disagreements", "item_pool.jsonl");
	}
	judge(model: string): string {
		return join(this.root, "judges", `${modelSlug(model)}.jsonl`);
	}
	judgeCheckpoint(model: string): string {
		return join(this.root, "judges", `.${modelSlug(model)}.checkpoint.jsonl`);
	}
	human(annotator: string): string {
		return join(this.root, "human", `${modelSlug(annotator)}.jsonl`);
	}
	get humanDir(): string {
		return join(this.root, "human");
	}
	get summaryJson(): string {
		return join(this.root, "summary.json");
	}
	get summaryMarkdown(): string {
		return join(this.root, "summary.md");
	}
}
