import type { HierarchyEntry } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { asRecordArray, asString, asStringArray, isRecord, parseJsonObject } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import { bulleted, uniqueInOrder } from "../core/text.ts";
import type { Embedder } from "../embeddings/embedder.ts";
import { nearestRows } from "../embeddings/vector.ts";
import type { LlmClient } from "../llm/types.ts";
import { assignCodesToSubthemesPrompt, intraClusterSubthemePrompt } from "../prompts/pipeline.ts";

export const SMALL_CLUSTER_MAX = 5;

interface WorkingSubTheme {
	name: string;
	codes: string[];
}

export interface HierarchyDeps {
	llm: LlmClient;
	embedder: Embedder;
	researchQuestion: string;
	settings: IdcoderConfig["hierarchy"];
	logger: Logger;
	signal?: AbortSignal | undefined;
}

/** Moves every ungrouped code to its most similar sub-theme name. */
export async function drainUngrouped(
	subThemes: WorkingSubTheme[],
	ungrouped: readonly string[],
	embedder: Embedder,
	signal?: AbortSignal,
): Promise<string[]> {
	if (subThemes.length === 0 || ungrouped.length === 0) return [...ungrouped];
	const names = await embedder.embed(
		subThemes.map((st) => st.name),
		signal,
	);
	const codes = await embedder.embed(ungrouped, signal);
	nearestRows(codes, names).forEach((target, i) => {
		subThemes[target]!.codes.push(ungrouped[i]!);
	});
	return [];
}

/**
 * Organises one cluster's codes into 2–5 named sub-themes: the first batch is grouped by the
 * LLM, overflow codes are assigned to those sub-themes in batches, and leftovers stay ungrouped.
 */
export async function buildClusterHierarchy(
	clusterId: string,
	label: string,
	codes: readonly string[],
	deps: HierarchyDeps,
): Promise<HierarchyEntry> {
	const { llm, settings, logger, signal } = deps;
	const unique = uniqueInOrder(codes);
	if (unique.length <= SMALL_CLUSTER_MAX) return { label, sub_themes: [], ungrouped_codes: unique };

	const firstBatch = unique.slice(0, settings.firstBatchSize);
	const inBatch = new Set(firstBatch);
	let parsed: Record<string, unknown>;
	try {
		const response = await llm.complete({
			skill: "hierarchy_construction",
			prompt: intraClusterSubthemePrompt(label, bulleted(firstBatch), deps.researchQuestion),
			labels: { cluster_id: clusterId, phase: "subtheme" },
			signal,
		});
		parsed = parseJsonObject(response.text);
	} catch (error) {
		if (signal?.aborted) throw error;
		logger.warn("HIERARCHY_LLM_ERROR", `Cluster ${clusterId}: ${(error as Error).message}`);
		return { label, sub_themes: [], ungrouped_codes: unique };
	}

	const assigned = new Set<string>();
	const subThemes: WorkingSubTheme[] = [];
	for (const st of asRecordArray(parsed.sub_themes)) {
		const stCodes = asStringArray(st.codes).filter((c) => inBatch.has(c));
		for (const c of stCodes) assigned.add(c);
		if (stCodes.length) subThemes.push({ name: asString(st.name, "Unnamed") || "Unnamed", codes: stCodes });
	}
	const ungrouped = asStringArray(parsed.ungrouped_codes).filter((c) => inBatch.has(c) && !assigned.has(c));
	for (const c of ungrouped) assigned.add(c);
	ungrouped.push(...firstBatch.filter((c) => !assigned.has(c)));

	const remaining = unique.slice(settings.firstBatchSize);
	if (remaining.length > 0) {
		const names = subThemes.map((st) => st.name);
		if (names.length === 0) {
			ungrouped.push(...remaining);
		} else {
			for (let start = 0, chunkIndex = 0; start < remaining.length; start += settings.assignBatch, chunkIndex++) {
				const chunk = remaining.slice(start, start + settings.assignBatch);
				const inChunk = new Set(chunk);
				try {
					const response = await llm.complete({
						skill: "hierarchy_construction",
						prompt: assignCodesToSubthemesPrompt(label, names, chunk, deps.researchQuestion),
						labels: { cluster_id: clusterId, phase: "assign", chunk_index: chunkIndex },
						signal,
					});
					const result = parseJsonObject(response.text);
					const placed = new Set<string>();
					const assignments = isRecord(result.assignments) ? result.assignments : {};
					for (const [name, list] of Object.entries(assignments)) {
						if (!Array.isArray(list)) continue;
						const target = subThemes.find((st) => st.name === name);
						if (!target) continue;
						const valid = asStringArray(list).filter((c) => inChunk.has(c));
						target.codes.push(...valid);
						for (const c of valid) placed.add(c);
					}
					for (const c of asStringArray(result.unassigned)) {
						if (inChunk.has(c) && !placed.has(c)) {
							ungrouped.push(c);
							placed.add(c);
						}
					}
					ungrouped.push(...chunk.filter((c) => !placed.has(c)));
				} catch (error) {
					if (signal?.aborted) throw error;
					logger.warn(
						"HIERARCHY_BATCH2_ERROR",
						`Cluster ${clusterId} chunk ${chunkIndex}: ${(error as Error).message}`,
					);
					ungrouped.push(...chunk);
				}
			}
		}
	}

	let finalUngrouped = ungrouped;
	if (settings.embedDrain && ungrouped.length > settings.drainThreshold && subThemes.length > 0) {
		try {
			finalUngrouped = await drainUngrouped(subThemes, ungrouped, deps.embedder, signal);
		} catch (error) {
			if (signal?.aborted) throw error;
			logger.warn("HIERARCHY_EMBED_DRAIN_ERROR", `Cluster ${clusterId}: ${(error as Error).message}`);
		}
	}
	return { label, sub_themes: subThemes, ungrouped_codes: finalUngrouped };
}
