import type { ArtifactStore } from "../artifacts/store.ts";
import { resolveViewerDir } from "../config/load.ts";
import { readJson, writeJson } from "../core/fs.ts";
import { buildCodeEvidence } from "../evidence/code-evidence.ts";
import { loadOrBuildSourceMemory } from "../evidence/source-memory.ts";
import { done, type Stage, type StageContext } from "../pipeline/stage.ts";
import { applyCodebookReview, materializeClustered } from "../review/apply.ts";
import { findSavedApproval } from "../review/gateway.ts";
import { buildV1, type EnrichedCodebook } from "../review/schema.ts";
import { exportCodebookReview } from "../viewer/data.ts";

/** Writes the reviewed codebook over the pipeline artifacts and records provenance. */
export async function materializeApproval(
	store: ArtifactStore,
	payload: EnrichedCodebook,
	options: { reviewId: string | null; approvedAt?: string | undefined },
): Promise<{ clusters: number; orphaned: number }> {
	const clustered = await store.clustered();
	const result = applyCodebookReview(payload, clustered, options);
	await store.writeCodebook({ codebook: result.codebook, cluster_to_codes: result.clusterToCodes });
	await store.writeConfidence(result.confidence);
	await store.writeClustered(materializeClustered(result, clustered));
	await store.writeProvenance(result.provenance);
	return { clusters: Object.keys(result.codebook).length, orphaned: result.orphanedCodes.length };
}

export async function buildProposal(store: ArtifactStore): Promise<EnrichedCodebook> {
	const codebook = await store.codebook();
	return buildV1(codebook.codebook, codebook.cluster_to_codes, await store.confidence());
}

async function stageForViewer(ctx: StageContext, proposal: EnrichedCodebook, viewerDir: string): Promise<void> {
	await writeJson(ctx.paths.codebookV1, proposal);
	const memory = await loadOrBuildSourceMemory({
		markdownPath: ctx.paths.openCodesMarkdown,
		memoryPath: ctx.paths.sourceMemory,
		logger: ctx.logger,
	});
	const clustered = await ctx.store.clustered();
	const evidence = buildCodeEvidence(memory, {
		slug: ctx.slug,
		researchQuestion: ctx.config.study.researchQuestion,
		openCodes: Object.values(proposal.cluster_to_codes).flat(),
		...(clustered.dedup_map ? { dedupMap: clustered.dedup_map } : {}),
	});
	await exportCodebookReview({
		root: viewerDir,
		slug: ctx.slug,
		researchQuestion: ctx.config.study.researchQuestion,
		paths: ctx.paths,
		evidence,
	});
}

/**
 * Paper §3.1 "Optional Human-in-the-loop Review": the pipeline stops after labeling until a
 * researcher approves (possibly edited) clusters through any review channel.
 */
export const reviewGateStage: Stage = {
	id: "codebook_review",
	title: "Codebook review (human)",
	enabled: (config) => config.review.enabled,
	async run(ctx) {
		const existing = await ctx.store.provenance();
		if (existing) return done(`Codebook already approved at ${existing.approved_at}`);

		const viewerDir = resolveViewerDir(ctx.config, ctx.projectDir);
		const saved = await findSavedApproval(ctx.paths, viewerDir, ctx.slug);
		let payload: EnrichedCodebook;
		let reviewId: string | null = ctx.slug;
		let approvedAt: string | undefined;
		if (saved) {
			payload = await readJson<EnrichedCodebook>(saved);
			ctx.logger.info("CODEBOOK_REVIEW_FOUND", saved);
		} else {
			const proposal = await buildProposal(ctx.store);
			await stageForViewer(ctx, proposal, viewerDir);
			const decision = await ctx.review.review({
				slug: ctx.slug,
				researchQuestion: ctx.config.study.researchQuestion,
				paths: ctx.paths,
				viewerDir,
				proposal,
				signal: ctx.signal,
			});
			if (decision.kind === "pending") return { status: "paused", summary: decision.message };
			payload = decision.payload;
			reviewId = decision.reviewId;
			approvedAt = decision.approvedAt;
			await writeJson(ctx.paths.codebookV2, payload);
		}

		const { clusters, orphaned } = await materializeApproval(ctx.store, payload, { reviewId, approvedAt });
		ctx.logger.info("CODEBOOK_REVIEW_MATERIALIZED", `review_id=${reviewId} clusters=${clusters}`);
		return done(`Approved codebook with ${clusters} clusters (${orphaned} orphaned codes)`, { clusters, orphaned });
	},
};
