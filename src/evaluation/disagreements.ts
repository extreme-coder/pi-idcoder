import { createHash } from "node:crypto";
import type { EnrichedEntry } from "../artifacts/types.ts";
import { Rng } from "../core/random.ts";
import { judgeOption } from "./ground-truth.ts";
import type { DisagreementItem, RecodeRow } from "./types.ts";

/**
 * Every quote where a deductive agent picked a concrete alternative theme becomes one blind A/B
 * question, de-duplicated across agents: (quote, inductive theme, alternative) is asked once no
 * matter how many agents raised it. Item ids and option order derive from the item's content
 * (quote and both options' text), so rebuilding the pool never re-points saved verdicts at a
 * different question, and a changed codebook yields new ids rather than stale verdicts.
 */
export function buildItemPool(
	rowsByModel: ReadonlyMap<string, readonly RecodeRow[]>,
	dimensions: readonly EnrichedEntry[],
	seed: number,
): DisagreementItem[] {
	const byKey = new Map<string, { row: RecodeRow; raisedBy: string[] }>();
	for (const [model, rows] of rowsByModel) {
		for (const row of rows) {
			if (row.status !== "classified" || row.agree || row.pred_meta_theme_idx === null) continue;
			const key = JSON.stringify([row.review_idx, row.open_code, row.quote, row.pred_meta_theme_idx]);
			const existing = byKey.get(key);
			if (existing) {
				if (!existing.raisedBy.includes(model)) existing.raisedBy.push(model);
			} else {
				byKey.set(key, { row, raisedBy: [model] });
			}
		}
	}
	const rng = new Rng(seed);
	return [...byKey.values()].map(({ row, raisedBy }) => {
		const inductive = judgeOption(dimensions[row.true_meta_theme_idx], row.true_meta_theme_label);
		const deductive = judgeOption(dimensions[row.pred_meta_theme_idx!], row.pred_meta_theme_label);
		const identity = JSON.stringify([row.review_idx, row.open_code, row.quote, inductive, deductive]);
		const inductiveFirst = rng.fork(identity).next() < 0.5;
		return {
			item_id: `item_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
			review_idx: row.review_idx,
			open_code: row.open_code,
			quote: row.quote,
			option_a: inductiveFirst ? inductive : deductive,
			option_b: inductiveFirst ? deductive : inductive,
			true_side: inductiveFirst ? "A" : "B",
			true_label: row.true_meta_theme_label,
			pred_label: row.pred_meta_theme_label,
			raised_by: raisedBy,
		};
	});
}
