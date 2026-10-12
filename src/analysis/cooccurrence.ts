import type { ReviewCodes, TreeNode } from "../artifacts/types.ts";
import { addNested } from "../core/collections.ts";
import { isRecord } from "../core/json.ts";

export interface PairCount {
	pair: [string, string];
	count: number;
	pct_reviews: number;
}

export interface CoverageEntry {
	count: number;
	pct: number;
}

export interface CooccurrenceFile {
	meta_theme_matrix: Record<string, Record<string, number>>;
	theme_matrix: Record<string, Record<string, number>>;
	top_meta_theme_pairs: PairCount[];
	top_theme_pairs: PairCount[];
	review_coverage: { meta_themes: Record<string, CoverageEntry>; themes: Record<string, CoverageEntry> };
	total_reviews: number;
}

/** Maps each code leaf to its theme and meta-theme by walking the global tree. */
export function codeMapsFromGraph(graph: unknown): { theme: Map<string, string>; meta: Map<string, string> } {
	if (!isRecord(graph) || !isRecord(graph.tree)) {
		throw new Error("gt_global_graph.json must contain a 'tree' object (run tree assembly first).");
	}
	const theme = new Map<string, string>();
	const meta = new Map<string, string>();
	const visit = (node: TreeNode, metaName?: string, themeName?: string): void => {
		const children = (node.children ?? []).filter(isRecord) as unknown as TreeNode[];
		switch (node.type) {
			case "root":
				for (const c of children) visit(c);
				break;
			case "meta_theme":
				for (const c of children) visit(c, String(node.name));
				break;
			case "theme":
				for (const c of children) visit(c, metaName, String(node.name));
				break;
			case "code":
				if (metaName !== undefined && themeName !== undefined && node.name) {
					theme.set(String(node.name), themeName);
					meta.set(String(node.name), metaName);
				}
				break;
			default:
				for (const c of children) visit(c, metaName, themeName);
		}
	};
	visit(graph.tree as unknown as TreeNode);
	return { theme, meta };
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

function symmetricMatrix(pairs: Map<string, number>): Record<string, Record<string, number>> {
	const out: Record<string, Record<string, number>> = {};
	for (const [key, count] of pairs) {
		const [a, b] = JSON.parse(key) as [string, string];
		if (a === b || count <= 0) continue;
		addNested(out, a, b, count);
		addNested(out, b, a, count);
	}
	return out;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function topPairs(pairs: Map<string, number>, totalReviews: number, limit = 500): PairCount[] {
	const denom = totalReviews > 0 ? totalReviews : 1;
	return [...pairs.entries()]
		.map(([key, count]) => ({ pair: JSON.parse(key) as [string, string], count }))
		.sort((x, y) => y.count - x.count || compare(x.pair[0], y.pair[0]) || compare(x.pair[1], y.pair[1]))
		.slice(0, limit)
		.map(({ pair, count }) => ({ pair, count, pct_reviews: round6(count / denom) }));
}

function coverage(hits: Map<string, number>, totalReviews: number): Record<string, CoverageEntry> {
	const denom = totalReviews > 0 ? totalReviews : 1;
	return Object.fromEntries(
		[...hits.entries()]
			.sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))
			.map(([name, count]) => [name, { count, pct: round6(count / denom) }]),
	);
}

function addPairs(target: Map<string, number>, items: ReadonlySet<string>): void {
	const sorted = [...items].sort(compare);
	for (let i = 0; i < sorted.length; i++) {
		for (let j = i + 1; j < sorted.length; j++) {
			const key = JSON.stringify([sorted[i], sorted[j]]);
			target.set(key, (target.get(key) ?? 0) + 1);
		}
	}
}

/** Theme and meta-theme pairs that co-occur within the same review (no LLM). */
export function buildCooccurrence(
	codesPerReview: unknown,
	graph: unknown,
): { data: CooccurrenceFile; skippedCodes: number } {
	const { theme, meta } = codeMapsFromGraph(graph);
	const rows = Array.isArray(codesPerReview) ? (codesPerReview as unknown[]) : [];
	const metaPairs = new Map<string, number>();
	const themePairs = new Map<string, number>();
	const metaHits = new Map<string, number>();
	const themeHits = new Map<string, number>();
	let skipped = 0;
	for (const row of rows) {
		if (!Array.isArray(row) || row.length < 2 || !Array.isArray(row[1])) continue;
		const metas = new Set<string>();
		const themes = new Set<string>();
		for (const code of (row as ReviewCodes)[1]) {
			if (typeof code !== "string") continue;
			const m = meta.get(code);
			const t = theme.get(code);
			if (m === undefined || t === undefined) {
				skipped++;
				continue;
			}
			metas.add(m);
			themes.add(t);
		}
		for (const m of metas) metaHits.set(m, (metaHits.get(m) ?? 0) + 1);
		for (const t of themes) themeHits.set(t, (themeHits.get(t) ?? 0) + 1);
		addPairs(metaPairs, metas);
		addPairs(themePairs, themes);
	}
	const total = rows.length;
	return {
		data: {
			meta_theme_matrix: symmetricMatrix(metaPairs),
			theme_matrix: symmetricMatrix(themePairs),
			top_meta_theme_pairs: topPairs(metaPairs, total),
			top_theme_pairs: topPairs(themePairs, total),
			review_coverage: { meta_themes: coverage(metaHits, total), themes: coverage(themeHits, total) },
			total_reviews: total,
		},
		skippedCodes: skipped,
	};
}
