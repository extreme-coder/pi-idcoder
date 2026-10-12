import type { DetailLevel } from "../config/schema.ts";
import { krippendorffAlphaNominal, percentAgreement } from "./krippendorff.ts";
import { rowKey } from "./recode.ts";
import type { RecodeRow } from "./types.ts";

export interface AgreementCell {
	model: string;
	level: DetailLevel;
	n_total: number;
	n_classified: number;
	n_unresolved: number;
	n_none: number;
	percent_agreement: number | null;
	alpha: number | null;
}

export interface LevelAgreement {
	level: DetailLevel;
	/** Krippendorff's alpha with the inductive agent and every deductive agent as coders. */
	alpha_all_coders: number | null;
	cells: AgreementCell[];
}

export interface AgreementReport {
	levels: LevelAgreement[];
}

const finiteOrNull = (x: number) => (Number.isFinite(x) ? x : null);

function predicted(row: RecodeRow): string {
	return row.pred_meta_theme_idx === null ? "NONE" : String(row.pred_meta_theme_idx);
}

/** Inductive vs one deductive agent (paper §3.3): unresolved calls are missing data, NONE is a category. */
export function agreementCell(
	model: string,
	level: DetailLevel,
	rows: readonly RecodeRow[],
	unresolved: number,
): AgreementCell {
	const classified = rows.filter((r) => r.status === "classified");
	const pairs = classified.map((r) => [String(r.true_meta_theme_idx), predicted(r)] as const);
	return {
		model,
		level,
		n_total: rows.length + unresolved,
		n_classified: classified.length,
		n_unresolved: unresolved,
		n_none: classified.filter((r) => r.pred_meta_theme_idx === null).length,
		percent_agreement: finiteOrNull(percentAgreement(pairs)),
		alpha: finiteOrNull(krippendorffAlphaNominal(pairs)),
	};
}

/** All coders at one detail level: units are quotes, coders are the inductive agent plus each model. */
export function allCodersAlpha(rowsByModel: ReadonlyMap<string, readonly RecodeRow[]>): number | null {
	const units = new Map<string, Array<string | null>>();
	const models = [...rowsByModel.keys()];
	models.forEach((model, m) => {
		for (const row of rowsByModel.get(model)!) {
			const key = rowKey(row);
			const unit = units.get(key) ?? [String(row.true_meta_theme_idx), ...models.map(() => null)];
			if (row.status === "classified") unit[m + 1] = predicted(row);
			units.set(key, unit);
		}
	});
	return finiteOrNull(krippendorffAlphaNominal([...units.values()]));
}

export function renderAgreementMarkdown(report: AgreementReport): string {
	const fmt = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
	const lines = [
		"| Level | Deductive agent | α | % agree | classified | NONE | unresolved |",
		"|---|---|---|---|---|---|---|",
	];
	for (const level of report.levels) {
		for (const c of level.cells) {
			lines.push(
				`| ${level.level} | ${c.model} | ${fmt(c.alpha)} | ${c.percent_agreement === null ? "n/a" : `${(c.percent_agreement * 100).toFixed(1)}%`} | ${c.n_classified}/${c.n_total} | ${c.n_none} | ${c.n_unresolved} |`,
			);
		}
		lines.push(`| ${level.level} | **all coders** | ${fmt(level.alpha_all_coders)} | | | | |`);
	}
	return lines.join("\n");
}
