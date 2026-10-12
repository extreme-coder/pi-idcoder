import type { MetaTheme } from "../artifacts/types.ts";
import { asRecordArray, asString } from "../core/json.ts";

/** Target meta-theme count: one for a single cluster, 2..n under six clusters, otherwise 3..7. */
export function metaThemeBounds(clusterCount: number): [number, number] {
	if (clusterCount <= 1) return [1, 1];
	if (clusterCount < 6) return [2, Math.min(7, clusterCount)];
	return [3, 7];
}

export function parseMetaThemes(value: unknown): MetaTheme[] {
	return asRecordArray(value).map((m) => ({
		name: asString(m.name),
		cluster_ids: Array.isArray(m.cluster_ids) ? m.cluster_ids.map(String) : [],
	}));
}

/** Every cluster belongs somewhere: missing ids join the largest group. Returns how many were added. */
export function assignMissingClusters(metaThemes: MetaTheme[], allIds: readonly string[]): number {
	const assigned = new Set(metaThemes.flatMap((m) => m.cluster_ids));
	const missing = allIds.filter((id) => !assigned.has(id));
	if (missing.length && metaThemes.length) {
		const largest = metaThemes.reduce((a, b) => (b.cluster_ids.length > a.cluster_ids.length ? b : a));
		largest.cluster_ids.push(...missing);
	}
	return missing.length;
}

export function splitLargest(metaThemes: MetaTheme[]): MetaTheme[] {
	const largest = metaThemes.reduce((a, b) => (b.cluster_ids.length > a.cluster_ids.length ? b : a));
	if (largest.cluster_ids.length < 2) return metaThemes;
	const ids = [...largest.cluster_ids];
	const mid = Math.floor(ids.length / 2);
	const base = largest.name.trim() || "Theme";
	largest.cluster_ids = ids.slice(0, mid);
	return [...metaThemes, { name: `${base} (continued)`, cluster_ids: ids.slice(mid) }];
}

export function mergeTwoSmallest(metaThemes: MetaTheme[]): MetaTheme[] {
	if (metaThemes.length < 2) return metaThemes;
	const order = metaThemes
		.map((m, i) => ({ m, i }))
		.sort((a, b) => a.m.cluster_ids.length - b.m.cluster_ids.length || a.i - b.i);
	const [first, second] = [order[0]!, order[1]!];
	const merged: MetaTheme = {
		name: `${first.m.name.trim() || "A"} / ${second.m.name.trim() || "B"}`,
		cluster_ids: [...first.m.cluster_ids, ...second.m.cluster_ids],
	};
	return [...metaThemes.filter((_, i) => i !== first.i && i !== second.i), merged];
}

/** Deterministic repair into the bounds by splitting the largest or merging the two smallest groups. */
export function normalizeMetaThemeCount(metaThemes: readonly MetaTheme[], clusterCount: number): MetaTheme[] {
	const [lo, hi] = metaThemeBounds(clusterCount);
	let current = metaThemes.map((m) => ({ ...m, cluster_ids: [...m.cluster_ids] }));
	for (let i = 0; i < 32; i++) {
		const n = current.length;
		if (n >= lo && n <= hi) return current;
		const next = n < lo ? splitLargest(current) : mergeTwoSmallest(current);
		if ((n < lo && next.length === n) || (n > hi && next.length >= n)) break;
		current = next;
	}
	return current;
}
