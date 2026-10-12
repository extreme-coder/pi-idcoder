import type { MetaTheme } from "../artifacts/types.ts";
import { sortClusterIds } from "../core/ids.ts";
import { parseJsonObject, removeThinkTags } from "../core/json.ts";
import { assignMissingClusters, metaThemeBounds, normalizeMetaThemeCount, parseMetaThemes } from "../hierarchy/meta.ts";
import { done, type Stage, type StageContext } from "../pipeline/stage.ts";
import { metaThemeCountReminder, metaThemeGroupingPrompt } from "../prompts/pipeline.ts";

async function requestMetaThemes(
	ctx: StageContext,
	labelsJson: string,
	extra: string,
	phase: string,
): Promise<MetaTheme[]> {
	const response = await ctx.llm.complete({
		skill: "meta_theme_grouping",
		prompt: metaThemeGroupingPrompt(labelsJson, ctx.config.study.researchQuestion) + extra,
		labels: { phase },
		signal: ctx.signal,
	});
	return parseMetaThemes(parseJsonObject(removeThinkTags(response.text)).meta_themes);
}

/** Groups cluster labels into a small handful of meta-themes (paper Fig. 1 meta-theme level). */
export const metaThemesStage: Stage = {
	id: "meta_themes",
	title: "Meta-theme grouping",
	enabled: () => true,
	async run(ctx) {
		const { codebook } = await ctx.store.codebook();
		const ids = sortClusterIds(Object.keys(codebook));
		if (ids.length === 0) throw new Error("No codebook in codebook.json.");
		const labelsJson = JSON.stringify(Object.fromEntries(ids.map((id) => [id, codebook[id]])), null, 2);
		const [lo, hi] = metaThemeBounds(ids.length);

		let metaThemes = await requestMetaThemes(ctx, labelsJson, "", "initial");
		if (metaThemes.length === 0) throw new Error("LLM returned invalid meta_themes structure.");
		let fixed = assignMissingClusters(metaThemes, ids);
		if (fixed) ctx.logger.info("META_THEME_FIXUP", `Added ${fixed} missing cluster(s) to the largest group`);

		if (metaThemes.length < lo || metaThemes.length > hi) {
			try {
				const retry = await requestMetaThemes(ctx, labelsJson, metaThemeCountReminder(lo, hi), "retry");
				if (retry.length) {
					metaThemes = retry;
					fixed = assignMissingClusters(metaThemes, ids);
					if (fixed) ctx.logger.info("META_THEME_FIXUP_RETRY", `Added ${fixed} missing cluster(s) after retry`);
				}
			} catch (error) {
				if (ctx.signal?.aborted) throw error;
				ctx.logger.warn("META_THEME_RETRY_ERROR", (error as Error).message);
			}
		}
		if (metaThemes.length < lo || metaThemes.length > hi) {
			const before = metaThemes.length;
			metaThemes = normalizeMetaThemeCount(metaThemes, ids.length);
			ctx.logger.info(
				"META_THEME_REPAIR",
				`Adjusted meta-theme count from ${before} to ${metaThemes.length} (bounds [${lo},${hi}])`,
			);
		}
		await ctx.store.writeMetaThemes({ meta_themes: metaThemes });
		return done(`Meta-themes: ${metaThemes.length} groups covering ${ids.length} clusters`, {
			meta_themes: metaThemes.length,
			clusters: ids.length,
		});
	},
};
