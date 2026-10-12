import { createHash } from "node:crypto";
import { ENRICHED_SCHEMA_VERSION, type EnrichedEntry } from "../artifacts/types.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl, writeJson } from "../core/fs.ts";
import { sortClusterIds } from "../core/ids.ts";
import { enrichCluster } from "../enrichment/codebook.ts";
import { entryFailed } from "../enrichment/criteria.ts";
import { assignOpenCodeIds, codeIdMapFile, shortLabel } from "../evidence/code-evidence.ts";
import { loadOrBuildSourceMemory } from "../evidence/source-memory.ts";
import { done, type Stage } from "../pipeline/stage.ts";

interface EnrichmentCheckpoint {
	cluster_id: string;
	input_hash: string;
	entry: EnrichedEntry;
}

function inputHash(label: string, codes: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify([label, codes]))
		.digest("hex")
		.slice(0, 16);
}

export const codebookEnrichmentStage: Stage = {
	id: "codebook_enrichment",
	title: "Codebook enrichment",
	enabled: (config) => config.enrichment.enabled,
	checkpoints: (paths) => [paths.enrichmentCheckpoint],
	async run(ctx) {
		const cb = await ctx.store.codebook();
		const ctc = cb.cluster_to_codes;
		if (Object.keys(ctc).length === 0) throw new Error("no cluster_to_codes in codebook.json");
		const ids = sortClusterIds(Object.keys(cb.codebook));
		const names = Object.fromEntries(ids.map((id) => [id, shortLabel(cb.codebook[id]!)]));

		const codeToId = assignOpenCodeIds(ctc);
		await writeJson(ctx.paths.codeIdMap, codeIdMapFile(codeToId));
		const docs = await ctx.corpus();
		const memory = await loadOrBuildSourceMemory({
			markdownPath: ctx.paths.openCodesMarkdown,
			memoryPath: ctx.paths.sourceMemory,
			sourceIds: new Map(docs.map((d) => [d.reviewId, d.sourceId])),
			codeToId,
			logger: ctx.logger,
		});
		const evidence = memory.evidenceByCode();

		const restored = new Map<string, EnrichmentCheckpoint>();
		for (const row of await readJsonl<EnrichmentCheckpoint>(ctx.paths.enrichmentCheckpoint))
			restored.set(row.cluster_id, row);
		const pending = ids.filter((id) => restored.get(id)?.input_hash !== inputHash(names[id]!, ctc[id] ?? []));

		const results = new Map<string, EnrichedEntry>(
			ids.filter((id) => !pending.includes(id)).map((id) => [id, restored.get(id)!.entry]),
		);
		let finished = results.size;
		await mapConcurrent(
			pending,
			ctx.config.enrichment.workers,
			async (id) => ({
				id,
				entry: await enrichCluster(id, names[id]!, ctc[id] ?? [], {
					llm: ctx.llm,
					memory,
					evidence,
					settings: ctx.config.enrichment,
					logger: ctx.logger,
					signal: ctx.signal,
				}),
			}),
			{
				signal: ctx.signal,
				onResult: async ({ id, entry }) => {
					results.set(id, entry);
					if (!entryFailed(entry)) {
						await appendJsonl(ctx.paths.enrichmentCheckpoint, {
							cluster_id: id,
							input_hash: inputHash(names[id]!, ctc[id] ?? []),
							entry,
						} satisfies EnrichmentCheckpoint);
					}
					ctx.logger.info("ENRICH_DONE", `Cluster ${id}: ${entry.label}`);
					ctx.progress({ done: ++finished, total: ids.length, message: entry.label });
				},
			},
		);

		const failed = ids.filter((id) => entryFailed(results.get(id)!)).map((id) => `${id}:${names[id]}`);
		if (failed.length) {
			throw new Error(
				`${failed.length} cluster(s) failed enrichment (empty result): ${failed.join(", ")}. Successful clusters are checkpointed; re-run to retry the rest.`,
			);
		}

		await ctx.store.writeCodebook({
			...cb,
			codebook: Object.fromEntries(ids.map((id) => [id, names[id]!])),
			codebook_enriched: Object.fromEntries(ids.map((id) => [id, results.get(id)!])),
			enriched_schema_version: ENRICHED_SCHEMA_VERSION,
		});
		const criteria = [...results.values()].reduce((n, e) => n + e.inclusion.length + e.exclusion.length, 0);
		return done(`Enriched ${ids.length} clusters with ${criteria} grounded criteria`, {
			clusters: ids.length,
			criteria,
		});
	},
};
