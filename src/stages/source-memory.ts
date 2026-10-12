import { resolveDataPath } from "../config/load.ts";
import { SourceMemory, saveSourceMemory } from "../evidence/source-memory.ts";
import { done, type Stage } from "../pipeline/stage.ts";

export const sourceMemoryStage: Stage = {
	id: "source_memory",
	title: "Source memory index",
	enabled: () => true,
	async run(ctx) {
		const docs = await ctx.corpus();
		const memory = SourceMemory.build(await ctx.store.openCodesMarkdown(), {
			sourceIds: new Map(docs.map((d) => [d.reviewId, d.sourceId])),
			dataPath: resolveDataPath(ctx.config, ctx.projectDir),
			logger: ctx.logger,
		});
		await saveSourceMemory(ctx.paths.sourceMemory, memory);
		return done(`Indexed ${memory.snippets.length} evidence snippets`, { snippets: memory.snippets.length });
	},
};
