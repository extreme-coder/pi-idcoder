import { createHash } from "node:crypto";
import { ENRICHED_SCHEMA_VERSION, type EnrichedEntry } from "../artifacts/types.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl } from "../core/fs.ts";
import { entryFailed } from "../enrichment/criteria.ts";
import { enrichDimension } from "../enrichment/dimensions.ts";
import { loadOrBuildSourceMemory } from "../evidence/source-memory.ts";
import { modelRefForRole } from "../llm/service.ts";
import { done, type Stage } from "../pipeline/stage.ts";

interface DimensionCheckpoint {
	index: number;
	input_hash: string;
	entry: EnrichedEntry;
}

export const dimensionEnrichmentStage: Stage = {
	id: "dimension_enrichment",
	title: "Dimension enrichment",
	enabled: (config) => config.enrichment.enabled,
	checkpoints: (paths) => [paths.dimensionsCheckpoint],
	async run(ctx) {
		const { meta_themes } = await ctx.store.metaThemes();
		if (meta_themes.length === 0) throw new Error("no meta_themes found in gt_meta_themes.json");
		const cb = await ctx.store.codebook();
		const evidenceMode = ctx.config.enrichment.dimensionEvidence;
		const memory = await loadOrBuildSourceMemory({
			markdownPath: ctx.paths.openCodesMarkdown,
			memoryPath: ctx.paths.sourceMemory,
			logger: ctx.logger,
		});
		const { quotes } = memory.evidenceByCode();
		const hashOf = (i: number) =>
			createHash("sha256")
				.update(
					JSON.stringify([
						ctx.config.enrichment,
						modelRefForRole(ctx.config.models, "enrichment"),
						meta_themes[i],
						cb.cluster_to_codes,
					]),
				)
				.digest("hex")
				.slice(0, 16);

		const results = new Map<number, EnrichedEntry>();
		for (const row of await readJsonl<DimensionCheckpoint>(ctx.paths.dimensionsCheckpoint)) {
			if (row.index < meta_themes.length && row.input_hash === hashOf(row.index)) results.set(row.index, row.entry);
		}
		const pending = meta_themes.map((_, i) => i).filter((i) => !results.has(i));
		let finished = results.size;
		await mapConcurrent(
			pending,
			ctx.config.enrichment.workers,
			async (i) => {
				const mt = meta_themes[i]!;
				const entry = await enrichDimension(mt.name || `Dimension ${i}`, mt.cluster_ids.map(String), {
					llm: ctx.llm,
					memory,
					quotes,
					clusterToCodes: cb.cluster_to_codes,
					settings: ctx.config.enrichment,
					logger: ctx.logger,
					signal: ctx.signal,
				});
				return { i, entry: { ...entry, cluster_ids: mt.cluster_ids } };
			},
			{
				signal: ctx.signal,
				onResult: async ({ i, entry }) => {
					results.set(i, entry);
					if (!entryFailed(entry)) {
						await appendJsonl(ctx.paths.dimensionsCheckpoint, {
							index: i,
							input_hash: hashOf(i),
							entry,
						} satisfies DimensionCheckpoint);
					}
					ctx.logger.info("DIM_ENRICH_DONE", entry.label);
					ctx.progress({ done: ++finished, total: meta_themes.length, message: entry.label });
				},
			},
		);

		const entries = meta_themes.map((_, i) => results.get(i)!);
		const failed = entries.filter(entryFailed).map((e) => e.label);
		if (failed.length) {
			throw new Error(
				`${failed.length} meta-theme(s) failed enrichment (empty result): ${failed.join(", ")}. Successful ones are checkpointed; re-run to retry.`,
			);
		}
		await ctx.store.writeDimensions(evidenceMode, {
			meta_themes_enriched: entries,
			enriched_schema_version: ENRICHED_SCHEMA_VERSION,
		});
		return done(`Enriched ${entries.length} dimensions (${evidenceMode} evidence)`, { dimensions: entries.length });
	},
};
