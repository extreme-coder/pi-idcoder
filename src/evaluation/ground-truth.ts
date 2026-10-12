import type { ClusteredCodesFile, DimensionsEnrichedFile, EnrichedEntry } from "../artifacts/types.ts";
import type { DetailLevel } from "../config/schema.ts";
import { optionLetter } from "../core/ids.ts";
import { parseOpenCodingSnippets } from "../evidence/source-memory.ts";
import type { GroundTruthRow, JudgeOptionText } from "./types.ts";

/**
 * Every quote's inductive meta-theme via open code → cluster → meta-theme. Codes merged during
 * deduplication are resolved through the dedup map (the original evaluation silently dropped them).
 */
export function buildGroundTruth(
	markdown: string,
	clustered: Pick<ClusteredCodesFile, "cluster_to_codes" | "dedup_map">,
	dimensions: DimensionsEnrichedFile,
): GroundTruthRow[] {
	const clusterOfCode = new Map<string, string>();
	for (const [cid, codes] of Object.entries(clustered.cluster_to_codes))
		for (const code of codes) clusterOfCode.set(code, cid);
	const metaOfCluster = new Map<string, number>();
	dimensions.meta_themes_enriched.forEach((mt, i) => {
		for (const cid of mt.cluster_ids ?? []) metaOfCluster.set(String(cid), i);
	});

	const snippets = parseOpenCodingSnippets(markdown);
	const quotesByReview = new Map<number, string[]>();
	for (const s of snippets) quotesByReview.set(s.review_id, [...(quotesByReview.get(s.review_id) ?? []), s.quote]);

	const rows: GroundTruthRow[] = [];
	for (const s of snippets) {
		const cid = clusterOfCode.get(s.open_code) ?? clusterOfCode.get(clustered.dedup_map?.[s.open_code] ?? "");
		if (cid === undefined) continue;
		const mt = metaOfCluster.get(cid);
		if (mt === undefined) continue;
		rows.push({
			review_idx: s.review_id,
			open_code: s.open_code,
			quote: s.quote,
			sibling_quotes: (quotesByReview.get(s.review_id) ?? []).filter((q) => q !== s.quote),
			true_meta_theme_idx: mt,
			true_meta_theme_label: dimensions.meta_themes_enriched[mt]!.label,
		});
	}
	return rows;
}

export interface FormattedCodebook {
	text: string;
	labels: string[];
	letters: string[];
}

/**
 * Lettered meta-theme categories at the requested detail (paper §3.2: label / +definition /
 * +inclusion and exclusion criteria). Embedded examples are never shown, so a quote that happens
 * to be an example cannot leak its answer.
 */
export function formatCodebook(entries: readonly EnrichedEntry[], level: DetailLevel): FormattedCodebook {
	const letters = entries.map((_, i) => optionLetter(i));
	const blocks = entries.map((entry, i) => {
		const lines = [`[${letters[i]}] LABEL: ${entry.label}`];
		if (level !== "theme_only") lines.push(`    DEFINITION: ${entry.definition}`);
		if (level === "full") {
			const inclusion = entry.inclusion.map((c) => c.criterion);
			const exclusion = entry.exclusion.map((c) => c.criterion);
			if (inclusion.length) lines.push("    INCLUSION CRITERIA:", ...inclusion.map((c) => `      - ${c}`));
			if (exclusion.length) lines.push("    EXCLUSION CRITERIA:", ...exclusion.map((c) => `      - ${c}`));
		}
		return lines.join("\n");
	});
	return { text: blocks.join("\n\n"), labels: entries.map((e) => e.label), letters };
}

export function judgeOption(entry: EnrichedEntry | undefined, label: string): JudgeOptionText {
	return {
		label,
		definition: entry?.definition ?? "",
		inclusion: entry?.inclusion.map((c) => c.criterion) ?? [],
		exclusion: entry?.exclusion.map((c) => c.criterion) ?? [],
	};
}
