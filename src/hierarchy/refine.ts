import type { HierarchyEntry, HierarchyFile, SubTheme } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { sortClusterIds } from "../core/ids.ts";
import { asString, parseJsonObject } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import { bulleted, uniqueInOrder } from "../core/text.ts";
import type { LlmClient } from "../llm/types.ts";
import { hierarchyRefineBucketPrompt } from "../prompts/pipeline.ts";

/**
 * Caps fan-out in the hierarchy for readability: oversized code buckets are split by the LLM into
 * named sub-groups (recursively, up to a depth limit) with a deterministic chunking fallback, and
 * ungrouped codes are folded into named sub-themes.
 */

export type RefineSettings = IdcoderConfig["hierarchy"]["refine"];

export interface RefineDeps {
	llm: LlmClient;
	researchQuestion: string;
	settings: RefineSettings;
	logger: Logger;
	signal?: AbortSignal | undefined;
}

interface Group {
	name: string;
	codes: string[];
}

export function groupsForSplit(n: number, cap: number): number {
	return Math.min(12, Math.max(2, Math.ceil(n / cap)));
}

export function deterministicLeaves(codes: readonly string[], cap: number, prefix: string): Group[] {
	const out: Group[] = [];
	for (let i = 0; i < codes.length; i += cap) {
		out.push({ name: `${prefix} (part ${i / cap + 1})`, codes: codes.slice(i, i + cap) });
	}
	return out;
}

function multiset(codes: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
	return counts;
}

function sameMultiset(a: Map<string, number>, b: Map<string, number>): boolean {
	if (a.size !== b.size) return false;
	for (const [k, v] of a) if (b.get(k) !== v) return false;
	return true;
}

/** Accepts a split only when every input code appears exactly once across non-empty groups. */
export function validateSplit(original: readonly string[], groups: unknown): Group[] | undefined {
	if (!Array.isArray(groups) || groups.length === 0) return undefined;
	const normalized: Group[] = [];
	for (const g of groups) {
		if (typeof g !== "object" || g === null || Array.isArray(g)) return undefined;
		const record = g as Record<string, unknown>;
		if (!Array.isArray(record.codes)) return undefined;
		const codes = record.codes.filter((c): c is string => typeof c === "string");
		if (codes.length === 0) continue;
		normalized.push({ name: asString(record.name).trim() || "Unnamed", codes });
	}
	if (!sameMultiset(multiset(original), multiset(normalized.flatMap((g) => g.codes)))) return undefined;
	return normalized.length ? normalized : undefined;
}

async function splitOnce(
	clusterLabel: string,
	bucketLabel: string,
	codes: readonly string[],
	depth: number,
	deps: RefineDeps,
): Promise<Group[] | undefined> {
	if (codes.length === 0) return undefined;
	const numGroups = groupsForSplit(codes.length, deps.settings.maxCodesPerBucket);
	let subs: unknown;
	try {
		const response = await deps.llm.complete({
			skill: "hierarchy_refine",
			prompt: hierarchyRefineBucketPrompt(
				clusterLabel,
				bucketLabel,
				bulleted(codes),
				deps.researchQuestion,
				numGroups,
			),
			labels: { phase: "hierarchy_refine", cluster_label: clusterLabel, bucket_label: bucketLabel, depth },
			signal: deps.signal,
		});
		subs = parseJsonObject(response.text).sub_themes;
	} catch (error) {
		if (deps.signal?.aborted) throw error;
		deps.logger.warn(
			"HIERARCHY_REFINE_LLM",
			`parse/call error for ${JSON.stringify(bucketLabel)}: ${(error as Error).message}`,
		);
		return undefined;
	}
	const validated = validateSplit(codes, subs);
	if (!validated) {
		deps.logger.warn("HIERARCHY_REFINE_VALIDATION", `LLM split failed validation for ${JSON.stringify(bucketLabel)}`);
		return undefined;
	}
	if (validated.length === 1 && validated[0]!.codes.length === codes.length) return undefined;
	return validated;
}

/** Splits in LLM-sized batches and merges groups by case-insensitive name. */
export async function splitBucket(
	clusterLabel: string,
	bucketLabel: string,
	codes: readonly string[],
	depth: number,
	deps: RefineDeps,
): Promise<Group[] | undefined> {
	const { maxCodesPerBucket: cap, llmMaxCodes } = deps.settings;
	if (codes.length <= llmMaxCodes) return splitOnce(clusterLabel, bucketLabel, codes, depth, deps);

	const nBatch = Math.ceil(codes.length / llmMaxCodes);
	deps.logger.info(
		"HIERARCHY_REFINE_LLM_BATCH",
		`${JSON.stringify(bucketLabel)}: ${codes.length} codes in ${nBatch} LLM batches (max ${llmMaxCodes} codes/call).`,
	);
	const merged = new Map<string, Group>();
	for (let b = 0; b < nBatch; b++) {
		const batch = codes.slice(b * llmMaxCodes, (b + 1) * llmMaxCodes);
		const groups =
			(await splitOnce(clusterLabel, `${bucketLabel} (batch ${b + 1}/${nBatch})`, batch, depth, deps)) ??
			deterministicLeaves(batch, cap, `${bucketLabel} (batch ${b + 1})`);
		for (const g of groups) {
			const key = g.name.toLowerCase();
			const existing = merged.get(key) ?? { name: g.name, codes: [] };
			existing.codes.push(...g.codes);
			merged.set(key, existing);
		}
	}
	const combined = [...merged.values()];
	if (!sameMultiset(multiset(codes), multiset(combined.flatMap((g) => g.codes)))) {
		deps.logger.warn(
			"HIERARCHY_REFINE_VALIDATION",
			`Batched merge for ${JSON.stringify(bucketLabel)}: code multiset mismatch`,
		);
		return undefined;
	}
	if (combined.length === 1 && combined[0]!.codes.length === codes.length) return undefined;
	return combined;
}

function chunked(codes: readonly string[], cap: number, name: string): SubTheme {
	const leaves = deterministicLeaves(codes, cap, name);
	return leaves.length === 1 ? leaves[0]! : { name, sub_themes: leaves };
}

/** Returns a leaf `{name, codes}` within the cap, or an internal node with nested sub-themes. */
export async function refineLeafBucket(
	clusterLabel: string,
	bucketLabel: string,
	codesIn: readonly string[],
	depth: number,
	deps: RefineDeps,
): Promise<SubTheme> {
	const { maxCodesPerBucket: cap, maxDepth } = deps.settings;
	const codes = uniqueInOrder(codesIn);
	if (codes.length <= cap || depth >= maxDepth) {
		return codes.length > cap ? chunked(codes, cap, bucketLabel) : { name: bucketLabel, codes };
	}
	const groups = await splitBucket(clusterLabel, bucketLabel, codes, depth, deps);
	if (!groups) return chunked(codes, cap, bucketLabel);
	const children: SubTheme[] = [];
	for (const g of groups) children.push(await refineLeafBucket(clusterLabel, g.name, g.codes, depth + 1, deps));
	return children.length === 1 ? children[0]! : { name: bucketLabel, sub_themes: children };
}

export async function refineSubTheme(
	st: SubTheme,
	clusterLabel: string,
	depth: number,
	deps: RefineDeps,
): Promise<SubTheme> {
	const name = st.name?.trim() || "Unnamed";
	const codes = (st.codes ?? []).filter((c): c is string => typeof c === "string");
	const nested = (st.sub_themes ?? []).filter((c) => typeof c === "object" && c !== null);
	if (nested.length > 0) {
		const children: SubTheme[] = [];
		for (const child of nested) children.push(await refineSubTheme(child, clusterLabel, depth + 1, deps));
		if (codes.length) {
			const extra = await refineLeafBucket(clusterLabel, name, codes, depth, deps);
			return children.length ? { name, sub_themes: [...children, extra] } : extra;
		}
		return children.length === 1 ? children[0]! : { name, sub_themes: children };
	}
	return refineLeafBucket(clusterLabel, name, codes, depth, deps);
}

export async function refineClusterEntry(entry: HierarchyEntry, deps: RefineDeps): Promise<HierarchyEntry> {
	const label = entry.label;
	const subThemes: SubTheme[] = [];
	for (const st of (entry.sub_themes ?? []).filter((x) => typeof x === "object" && x !== null)) {
		subThemes.push(await refineSubTheme(st, label, 0, deps));
	}
	const ungrouped = (entry.ungrouped_codes ?? []).filter((c): c is string => typeof c === "string");
	if (ungrouped.length > deps.settings.maxCodesPerBucket) {
		const extra = await refineLeafBucket(label, `Further themes (${label})`, ungrouped, 0, deps);
		if (extra.sub_themes?.length) subThemes.push(...extra.sub_themes);
		else if (extra.codes?.length) subThemes.push(extra);
	} else if (ungrouped.length) {
		subThemes.push({ name: "Ungrouped codes", codes: ungrouped });
	}
	return { label, sub_themes: subThemes, ungrouped_codes: [] };
}

export async function refineHierarchy(hierarchy: HierarchyFile, deps: RefineDeps): Promise<HierarchyFile> {
	const out: HierarchyFile = {};
	for (const id of sortClusterIds(Object.keys(hierarchy))) {
		out[id] = await refineClusterEntry(hierarchy[id]!, deps);
	}
	return out;
}
