import { join } from "node:path";
import { clusterByEmbedding } from "../cluster/axial-embedding.ts";
import { clusterByLlm } from "../cluster/axial-llm.ts";
import { writeJson } from "../core/fs.ts";
import { done, type Stage } from "../pipeline/stage.ts";

export const axialStage: Stage = {
	id: "axial_clustering",
	title: "Axial clustering",
	enabled: () => true,
	async run(ctx) {
		const { all_codes, codes_per_review } = await ctx.store.codesOnly();
		const settings = ctx.config.clustering;
		const result =
			settings.method === "llm"
				? await clusterByLlm(all_codes, codes_per_review, {
						llm: ctx.llm,
						researchQuestion: ctx.config.study.researchQuestion,
						settings: settings.llm,
						logger: ctx.logger,
						signal: ctx.signal,
						onIteration: async (iteration, clusters) => {
							if (settings.llm.saveIterations) {
								await writeJson(join(ctx.paths.llmClusteringDir, `cluster_iter_${iteration}.json`), clusters);
							}
						},
					})
				: await clusterByEmbedding(all_codes, codes_per_review, {
						embedder: ctx.embedder,
						config: settings,
						rng: ctx.rng,
						logger: ctx.logger,
						signal: ctx.signal,
					});
		await ctx.store.writeClustered(result.file);
		ctx.logger.info(
			"AXIAL_COMPLETE",
			result.summary.length > 500 ? `${result.summary.slice(0, 500)}...` : result.summary,
		);
		return done(`${result.file.k} clusters from ${result.file.all_codes.length} codes (${settings.method})`, {
			clusters: result.file.k,
			codes: result.file.all_codes.length,
		});
	},
};
