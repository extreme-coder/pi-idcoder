import type { RunPaths } from "../artifacts/paths.ts";
import { sleep } from "../core/concurrency.ts";
import { fileExists, readJson } from "../core/fs.ts";
import { findViewerApproval } from "../viewer/data.ts";
import type { EnrichedCodebook } from "./schema.ts";

export interface ReviewRequest {
	slug: string;
	researchQuestion: string;
	paths: RunPaths;
	viewerDir: string;
	proposal: EnrichedCodebook;
	signal?: AbortSignal | undefined;
}

export type ReviewDecision =
	| { kind: "approved"; payload: EnrichedCodebook; reviewId: string | null; approvedAt?: string }
	| { kind: "pending"; message: string };

/** How the codebook review gate reaches a human: terminal UI, browser viewer, or files. */
export interface ReviewGateway {
	review(request: ReviewRequest): Promise<ReviewDecision>;
}

/** An approval saved by any channel: `/idcoder review` in the run dir, or the viewer in viewer-data. */
export async function findSavedApproval(paths: RunPaths, viewerDir: string, slug: string): Promise<string | undefined> {
	if (await fileExists(paths.codebookV2)) return paths.codebookV2;
	return findViewerApproval(viewerDir, slug);
}

export function pendingMessage(request: Pick<ReviewRequest, "slug" | "paths" | "viewerDir">): string {
	return [
		`Codebook review for "${request.slug}" is waiting for a researcher.`,
		"Review it with /idcoder review (terminal) or /idcoder viewer (browser), then resume with /idcoder run.",
		`Approvals are read from ${request.paths.codebookV2} or ${request.viewerDir}/codebook-reviews/${request.slug}/codebook_v2.json.`,
	].join("\n");
}

/** Never blocks: the pipeline pauses at the gate and resumes once an approval file exists. */
export const pausingReviewGateway: ReviewGateway = {
	async review(request) {
		return { kind: "pending", message: pendingMessage(request) };
	},
};

/** Blocks until an approval file appears (for batch/HPC runs), polling at an interval. */
export class FileWaitReviewGateway implements ReviewGateway {
	private readonly timeoutMs: number;
	private readonly intervalMs: number;

	constructor(options: { timeoutSec: number; pollIntervalSec: number }) {
		this.timeoutMs = options.timeoutSec * 1000;
		this.intervalMs = options.pollIntervalSec * 1000;
	}

	async review(request: ReviewRequest): Promise<ReviewDecision> {
		const deadline = Date.now() + this.timeoutMs;
		for (;;) {
			const path = await findSavedApproval(request.paths, request.viewerDir, request.slug);
			if (path) {
				return { kind: "approved", payload: await readJson<EnrichedCodebook>(path), reviewId: request.slug };
			}
			if (Date.now() >= deadline) {
				return {
					kind: "pending",
					message: `No approval within ${Math.round(this.timeoutMs / 1000)}s.\n${pendingMessage(request)}`,
				};
			}
			await sleep(Math.min(this.intervalMs, Math.max(0, deadline - Date.now())), request.signal);
		}
	}
}
