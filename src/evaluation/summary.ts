import { type AgreementReport, renderAgreementMarkdown } from "./agreement.ts";
import { krippendorffAlphaNominal } from "./krippendorff.ts";
import type { HumanJudgment, JudgeRow, Preference } from "./types.ts";

export type Distribution = Record<Preference, number>;

export interface RaterGroupSummary {
	raters: number;
	judgments: number;
	items: number;
	distribution: Distribution;
	/** Share of decisive verdicts that favour the deductive assignment. */
	deductive_share_of_decisive: number | null;
	/** Krippendorff's alpha across raters over items judged by at least two of them. */
	inter_rater_alpha: number | null;
}

export interface EvaluationSummary {
	generated_at: string;
	items: number;
	agreement: AgreementReport | null;
	llm_judges: (RaterGroupSummary & { per_judge: Record<string, Distribution> }) | null;
	humans: (RaterGroupSummary & { per_annotator: Record<string, number> }) | null;
	/** Fraction of items judged by both groups where the human majority matches the LLM majority. */
	human_llm_majority_agreement: number | null;
}

const EMPTY = (): Distribution => ({ inductive: 0, deductive: 0, both: 0, neither: 0 });
const finiteOrNull = (x: number) => (Number.isFinite(x) ? x : null);

function distribution(preferences: Iterable<Preference>): Distribution {
	const d = EMPTY();
	for (const p of preferences) d[p]++;
	return d;
}

function majority(preferences: readonly Preference[]): Preference | null {
	const counts = distribution(preferences);
	const ranked = (Object.entries(counts) as Array<[Preference, number]>).sort((a, b) => b[1] - a[1]);
	return ranked[0]![1] > 0 && ranked[0]![1] !== ranked[1]![1] ? ranked[0]![0] : null;
}

function groupSummary(
	ratings: ReadonlyArray<{ rater: string; item: string; preferred: Preference }>,
): RaterGroupSummary {
	const byItem = new Map<string, Map<string, Preference>>();
	for (const r of ratings) {
		const item = byItem.get(r.item) ?? new Map<string, Preference>();
		item.set(r.rater, r.preferred);
		byItem.set(r.item, item);
	}
	const raters = [...new Set(ratings.map((r) => r.rater))];
	const units = [...byItem.values()].map((m) => raters.map((rater) => m.get(rater) ?? null));
	const d = distribution(ratings.map((r) => r.preferred));
	const decisive = d.inductive + d.deductive;
	return {
		raters: raters.length,
		judgments: ratings.length,
		items: byItem.size,
		distribution: d,
		deductive_share_of_decisive: decisive ? d.deductive / decisive : null,
		inter_rater_alpha: finiteOrNull(krippendorffAlphaNominal(units)),
	};
}

export function summarizeEvaluation(input: {
	items: number;
	agreement: AgreementReport | null;
	judgeRows: readonly JudgeRow[];
	humanJudgments: readonly HumanJudgment[];
}): EvaluationSummary {
	const llmRatings = input.judgeRows
		.filter((r): r is JudgeRow & { preferred: Preference } => r.status === "judged" && r.preferred !== null)
		.map((r) => ({ rater: r.judge, item: r.item_id, preferred: r.preferred }));
	const humanRatings = input.humanJudgments.map((h) => ({
		rater: h.annotator,
		item: h.item_id,
		preferred: h.preferred,
	}));

	const perJudge: Record<string, Distribution> = {};
	for (const r of llmRatings) {
		const d = perJudge[r.rater] ?? EMPTY();
		d[r.preferred]++;
		perJudge[r.rater] = d;
	}
	const perAnnotator: Record<string, number> = {};
	for (const r of humanRatings) perAnnotator[r.rater] = (perAnnotator[r.rater] ?? 0) + 1;

	const majorities = (ratings: typeof llmRatings) => {
		const grouped = new Map<string, Preference[]>();
		for (const r of ratings) grouped.set(r.item, [...(grouped.get(r.item) ?? []), r.preferred]);
		return new Map([...grouped].map(([item, prefs]) => [item, majority(prefs)]));
	};
	const llmMajority = majorities(llmRatings);
	const humanMajority = majorities(humanRatings);
	const shared = [...humanMajority.keys()].filter((item) => llmMajority.get(item) && humanMajority.get(item));
	const matches = shared.filter((item) => llmMajority.get(item) === humanMajority.get(item)).length;

	return {
		generated_at: new Date().toISOString(),
		items: input.items,
		agreement: input.agreement,
		llm_judges: llmRatings.length ? { ...groupSummary(llmRatings), per_judge: perJudge } : null,
		humans: humanRatings.length ? { ...groupSummary(humanRatings), per_annotator: perAnnotator } : null,
		human_llm_majority_agreement: shared.length ? matches / shared.length : null,
	};
}

function pct(x: number, total: number): string {
	return total ? `${((x / total) * 100).toFixed(1)}%` : "n/a";
}

function groupMarkdown(title: string, group: RaterGroupSummary): string[] {
	const d = group.distribution;
	const total = group.judgments;
	return [
		`## ${title}`,
		"",
		`${group.raters} rater(s), ${group.judgments} judgments over ${group.items} items.`,
		"",
		"| Prefers | Count | Share |",
		"|---|---|---|",
		`| inductive theme | ${d.inductive} | ${pct(d.inductive, total)} |`,
		`| deductive theme | ${d.deductive} | ${pct(d.deductive, total)} |`,
		`| both fit | ${d.both} | ${pct(d.both, total)} |`,
		`| neither fits | ${d.neither} | ${pct(d.neither, total)} |`,
		"",
		`Deductive share of decisive verdicts: ${group.deductive_share_of_decisive === null ? "n/a" : pct(group.deductive_share_of_decisive, 1)}`,
		`Inter-rater Krippendorff's α: ${group.inter_rater_alpha === null ? "n/a (needs overlapping items)" : group.inter_rater_alpha.toFixed(3)}`,
		"",
	];
}

export function renderSummaryMarkdown(summary: EvaluationSummary): string {
	const lines = [
		"# ID-Coder evaluation",
		"",
		`Generated ${summary.generated_at}. Disagreement items: ${summary.items}.`,
		"",
	];
	if (summary.agreement) {
		lines.push(
			"## Reconstruction agreement (inductive vs deductive)",
			"",
			renderAgreementMarkdown(summary.agreement),
			"",
		);
	}
	if (summary.llm_judges) lines.push(...groupMarkdown("LLM judges", summary.llm_judges));
	if (summary.humans) lines.push(...groupMarkdown("Human judges", summary.humans));
	if (summary.human_llm_majority_agreement !== null) {
		lines.push(
			`Human majority matches LLM majority on ${pct(summary.human_llm_majority_agreement, 1)} of shared items.`,
			"",
		);
	}
	return `${lines.join("\n").trim()}\n`;
}
