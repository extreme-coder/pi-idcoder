import { buildCooccurrence } from "../analysis/cooccurrence.ts";
import { buildGraphText, reportGraphMaxChars } from "../analysis/report.ts";
import { resolveViewerDir } from "../config/load.ts";
import { writeJson, writeTextAtomic } from "../core/fs.ts";
import { removeThinkTags } from "../core/json.ts";
import { refineHierarchy } from "../hierarchy/refine.ts";
import { assembleTree } from "../hierarchy/tree.ts";
import { done, type Stage } from "../pipeline/stage.ts";
import { researchReportPrompt } from "../prompts/pipeline.ts";
import { exportProject } from "../viewer/data.ts";

/** Caps hierarchy fan-out, then merges meta-themes and hierarchy into the global tree. */
export const treeAssemblyStage: Stage = {
	id: "tree_assembly",
	title: "Tree assembly",
	enabled: () => true,
	async run(ctx) {
		const { meta_themes } = await ctx.store.metaThemes();
		let hierarchy = await ctx.store.hierarchy();
		const { codebook } = await ctx.store.codebook();
		const refine = ctx.config.hierarchy.refine;
		if (refine.enabled) {
			ctx.logger.info(
				"HIERARCHY_REFINE",
				`cap=${refine.maxCodesPerBucket} max_depth=${refine.maxDepth} clusters=${Object.keys(hierarchy).length}`,
			);
			hierarchy = await refineHierarchy(hierarchy, {
				llm: ctx.llm,
				researchQuestion: ctx.config.study.researchQuestion,
				settings: refine,
				logger: ctx.logger,
				signal: ctx.signal,
			});
			await ctx.store.writeHierarchy(hierarchy);
		} else {
			ctx.logger.info("HIERARCHY_REFINE", "skipped (hierarchy.refine.enabled is false)");
		}
		const graph = assembleTree(ctx.config.study.researchQuestion, meta_themes, hierarchy, codebook);
		await ctx.store.writeGlobalGraph(graph);
		return done(`Tree assembled: ${graph.canonical_nodes.length} nodes, ${graph.edges.length} edges`, {
			nodes: graph.canonical_nodes.length,
			edges: graph.edges.length,
		});
	},
};

/** Answers the research question from the thematic tree (a dedicated report model may be configured). */
export const researchReportStage: Stage = {
	id: "research_report",
	title: "Research report",
	enabled: () => true,
	async run(ctx) {
		const graph = await ctx.store.globalGraph();
		const { text, truncated } = buildGraphText(graph, reportGraphMaxChars(ctx.config.report.contextTokens));
		if (truncated) ctx.logger.warn("RESEARCH_REPORT_GRAPH", "Graph payload was truncated to fit context budget.");
		const response = await ctx.llm.complete({
			skill: "research_report",
			prompt: researchReportPrompt(ctx.config.study.researchQuestion, text),
			role: "report",
			maxTokens: ctx.config.report.completionTokens,
			labels: { phase: "report" },
			signal: ctx.signal,
		});
		const report = `${removeThinkTags(response.text).trim()}\n`;
		await writeTextAtomic(ctx.paths.researchReport, report);
		return done(`Wrote research report (${report.length} chars)`);
	},
};

export const cooccurrenceStage: Stage = {
	id: "cooccurrence",
	title: "Co-occurrence network",
	enabled: () => true,
	async run(ctx) {
		const clustered = await ctx.store.clustered();
		const { data, skippedCodes } = buildCooccurrence(clustered.codes_per_review ?? [], await ctx.store.globalGraph());
		await writeJson(ctx.paths.cooccurrence, data);
		return done(`Co-occurrence over ${data.total_reviews} reviews (${skippedCodes} unmapped codes skipped)`, {
			reviews: data.total_reviews,
			skipped_codes: skippedCodes,
		});
	},
};

export const viewerExportStage: Stage = {
	id: "viewer_export",
	title: "Viewer export",
	enabled: (config) => config.viewer.export,
	async run(ctx) {
		const dir = await exportProject({
			root: resolveViewerDir(ctx.config, ctx.projectDir),
			slug: ctx.slug,
			researchQuestion: ctx.config.study.researchQuestion,
			paths: ctx.paths,
		});
		return done(`Exported project to ${dir}`);
	},
};
