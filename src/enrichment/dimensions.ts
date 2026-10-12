import type { ClusterToCodes, EnrichedEntry, GroundedExample } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { clusterTag, rawClusterId, sortClusterIds } from "../core/ids.ts";
import type { Logger } from "../core/logger.ts";
import { type SourceMemory, toGroundedExample } from "../evidence/source-memory.ts";
import type { LlmClient } from "../llm/types.ts";
import { dimensionEnrichmentPrompt, dimensionIdsCorrection } from "../prompts/pipeline.ts";
import { emptyEntry, entrySchema, filterCodeIds, parseEntry } from "./criteria.ts";

/** Quotes per cluster under `[CLxx]` headers; `limit` caps quotes per cluster (undefined = all). */
export function clusterQuotesBlock(
	clusterIds: readonly string[],
	clusterToCodes: ClusterToCodes,
	quotes: ReadonlyMap<string, readonly string[]>,
	limit: number | undefined,
): string {
	const lines: string[] = [];
	for (const cid of clusterIds) {
		lines.push(`- [${clusterTag(cid)}]`);
		let added = 0;
		outer: for (const code of clusterToCodes[cid] ?? []) {
			for (const quote of quotes.get(code) ?? []) {
				if (limit !== undefined && added >= limit) break outer;
				lines.push(`  [QUOTE] "${quote}"`);
				added++;
			}
		}
	}
	return lines.join("\n");
}

/** Every quote of every cluster outside this dimension, so exclusion criteria cite seen content. */
export function neighbourQuotesBlock(
	ownIds: readonly string[],
	clusterToCodes: ClusterToCodes,
	quotes: ReadonlyMap<string, readonly string[]>,
): string {
	const own = new Set(ownIds);
	const lines: string[] = [];
	for (const cid of sortClusterIds(Object.keys(clusterToCodes)).filter((id) => !own.has(id))) {
		const sample = (clusterToCodes[cid] ?? []).flatMap((code) => [...(quotes.get(code) ?? [])]);
		if (sample.length === 0) continue;
		lines.push(`- [${clusterTag(cid)}]`, ...sample.map((q) => `  [QUOTE] "${q}"`));
	}
	return lines.join("\n");
}

/** One grounded example per cited cluster (first unused snippet of its codes), max three per criterion. */
export function fillDimensionExamples(
	entry: EnrichedEntry,
	clusterToCodes: ClusterToCodes,
	memory: SourceMemory,
): void {
	const used = new Set<string>();
	for (const section of ["inclusion", "exclusion"] as const) {
		for (const item of entry[section]) {
			const examples: GroundedExample[] = [];
			for (const tag of item.code_ids) {
				for (const code of clusterToCodes[rawClusterId(tag)] ?? []) {
					const snippet = memory.pickSnippetForCode(code, used);
					if (snippet) {
						used.add(snippet.snippet_id);
						examples.push(toGroundedExample(snippet));
						break;
					}
				}
				if (examples.length === 3) break;
			}
			item.examples = examples;
		}
	}
}

export interface DimensionDeps {
	llm: LlmClient;
	memory: SourceMemory;
	quotes: ReadonlyMap<string, readonly string[]>;
	clusterToCodes: ClusterToCodes;
	settings: IdcoderConfig["enrichment"];
	logger: Logger;
	signal?: AbortSignal | undefined;
}

/** Codebook entry for one meta-theme; inclusion cites its own clusters, exclusion may cite any cluster. */
export async function enrichDimension(
	name: string,
	clusterIds: readonly string[],
	deps: DimensionDeps,
): Promise<EnrichedEntry> {
	const { llm, settings, logger, signal, clusterToCodes } = deps;
	const ownTags = clusterIds.map(clusterTag);
	const allTags = sortClusterIds(Object.keys(clusterToCodes)).map(clusterTag);
	const ownText = ownTags.join(", ");
	const allText = allTags.join(", ");
	const full = settings.dimensionEvidence === "full";
	const prompt = dimensionEnrichmentPrompt(
		name,
		ownText,
		allText,
		clusterQuotesBlock(clusterIds, clusterToCodes, deps.quotes, full ? undefined : settings.quotesPerCluster),
		full ? neighbourQuotesBlock(clusterIds, clusterToCodes, deps.quotes) : undefined,
	);
	const schema = entrySchema(full ? "dimension_entry_full" : "dimension_entry_no_example", ownTags, allTags);
	const ask = async (text: string) =>
		parseEntry(
			(
				await llm.complete({
					skill: "dimension_enrichment",
					prompt: text,
					role: "enrichment",
					jsonSchema: schema,
					labels: { dimension: name },
					signal,
				})
			).text,
			name,
		);

	try {
		let entry = await ask(prompt);
		let { bad, dropped } = filterCodeIds(entry, new Set(ownTags), new Set(allTags));
		if (bad.size) {
			logger.warn(
				"DIM_ENRICH_RETRY",
				`'${name}': invalid IDs ${[...bad].join(", ")} — retrying with explicit feedback`,
			);
			entry = await ask(prompt + dimensionIdsCorrection([...bad], ownText, allText));
			const second = filterCodeIds(entry, new Set(ownTags), new Set(allTags));
			dropped += second.dropped;
			if (second.bad.size) logger.warn("DIM_ENRICH_WARN", `'${name}': still invalid IDs after retry — dropped`);
		}
		if (dropped) logger.info("DIM_ENRICH_DROPPED", `'${name}': ${dropped} criteria dropped (no valid code_ids)`);
		fillDimensionExamples(entry, clusterToCodes, deps.memory);
		return entry;
	} catch (error) {
		if (signal?.aborted) throw error;
		logger.warn("DIM_ENRICH_WARN", `'${name}': ${(error as Error).message}`);
		return emptyEntry(name);
	}
}
