import type { EvaluationOutcome } from "../evaluation/runner.ts";
import type { RunEvent, RunResult } from "../pipeline/runner.ts";
import { STAGE_IDS, type StageId } from "../pipeline/stage.ts";
import type { RunState, StageRecord, StageStatus } from "../pipeline/state.ts";

const ICON: Record<StageStatus, string> = {
	done: "✓",
	skipped: "–",
	running: "●",
	paused: "⏸",
	failed: "✗",
	pending: "○",
};

export const STAGE_TITLES: Record<StageId, string> = {
	open_coding: "Open coding",
	source_memory: "Source memory",
	axial_clustering: "Axial clustering",
	cluster_labeling: "Cluster labeling",
	codebook_review: "Codebook review (human)",
	refine_assignments: "Refinement",
	codebook_enrichment: "Codebook enrichment",
	hierarchy: "Hierarchy",
	meta_themes: "Meta-themes",
	dimension_enrichment: "Dimension enrichment",
	tree_assembly: "Tree assembly",
	research_report: "Research report",
	cooccurrence: "Co-occurrence",
	viewer_export: "Viewer export",
};

export function stageLine(id: StageId, record: StageRecord): string {
	const detail = record.status === "failed" ? record.error : record.summary;
	return `${ICON[record.status]} ${STAGE_TITLES[id]}${detail ? ` — ${detail}` : ""}`;
}

export function stageLines(state: RunState): string[] {
	return STAGE_IDS.map((id) => stageLine(id, state.stages[id]));
}

export function nextStep(state: RunState): string {
	const paused = STAGE_IDS.find((id) => state.stages[id].status === "paused");
	if (paused) return "Review the codebook with /idcoder review (or /idcoder viewer), then /idcoder run to continue.";
	const failed = STAGE_IDS.find((id) => state.stages[id].status === "failed");
	if (failed) return `Fix the problem above, then /idcoder run resumes from ${STAGE_TITLES[failed]}.`;
	const pending = STAGE_IDS.find(
		(id) => state.stages[id].status === "pending" || state.stages[id].status === "running",
	);
	if (pending) return `Run /idcoder run to continue from ${STAGE_TITLES[pending]}.`;
	return "Pipeline complete. Run /idcoder evaluate for deductive recoding, agreement, and judging.";
}

export function formatRunResult(result: RunResult, slug: string, runDir: string): string {
	const headline =
		result.status === "completed"
			? `ID-Coder run "${slug}" completed.`
			: result.status === "paused"
				? `ID-Coder run "${slug}" is paused at ${STAGE_TITLES[result.stage]}.`
				: result.status === "failed"
					? `ID-Coder run "${slug}" failed at ${STAGE_TITLES[result.stage]}: ${result.error.message}`
					: `ID-Coder run "${slug}" was stopped during ${STAGE_TITLES[result.stage]}; finished work is checkpointed.`;
	const lines = [headline, "", ...stageLines(result.state), ""];
	if (result.status === "paused") lines.push(result.message, "");
	lines.push(nextStep(result.state), `Artifacts: ${runDir}`);
	return lines.join("\n");
}

export function formatEvaluation(outcome: EvaluationOutcome): string {
	const lines = [`Evaluation steps: ${outcome.stepsRun.join(", ")}`];
	if (outcome.notes.length) lines.push("", ...outcome.notes.map((n) => `Note: ${n}`));
	if (outcome.summary) lines.push("", `Summary: ${outcome.paths.summaryMarkdown}`);
	lines.push(`Results: ${outcome.paths.root}`);
	return lines.join("\n");
}

/** Progress widget lines: one row per stage, with live counts for the running stage. */
export class ProgressView {
	private readonly records = new Map<StageId, { status: StageStatus; detail: string }>();

	apply(event: RunEvent): void {
		switch (event.type) {
			case "stage_start":
				this.records.set(event.stage, { status: "running", detail: "" });
				break;
			case "stage_progress": {
				const { done, total, message } = event.progress;
				this.records.set(event.stage, {
					status: "running",
					detail: `${done}/${total}${message ? ` · ${message}` : ""}`,
				});
				break;
			}
			case "stage_end":
				this.records.set(event.stage, { status: event.status, detail: event.summary });
				break;
			case "stage_error":
				this.records.set(event.stage, { status: "failed", detail: event.error });
				break;
		}
	}

	statusText(): string | undefined {
		const running = [...this.records.entries()].find(([, r]) => r.status === "running");
		return running ? `idcoder: ${STAGE_TITLES[running[0]]} ${running[1].detail}`.trim() : undefined;
	}

	lines(maxWidth = 100): string[] {
		return [...this.records.entries()].map(([id, r]) => {
			const line = `${ICON[r.status]} ${STAGE_TITLES[id]}${r.detail ? ` — ${r.detail}` : ""}`;
			return line.length > maxWidth ? `${line.slice(0, maxWidth - 1)}…` : line;
		});
	}
}
