import type { DisagreementItem, Verdict } from "../evaluation/types.ts";
import type { CodeEvidenceFile } from "../evidence/code-evidence.ts";
import type { JudgeOutcomes } from "../prompts/evaluation.ts";
import { CodebookReviewError } from "../review/apply.ts";
import type { EnrichedCodebook } from "../review/schema.ts";
import type { ClusterView, ReviewSession } from "../review/session.ts";
import { checklistKey, initialChecklist, renderChecklist } from "./checklist.ts";
import { type JudgeKeyResult, judgeKey, renderJudgeItem } from "./judge-model.ts";
import type { UiPort } from "./port.ts";
import {
	clampReviewState,
	initialReviewState,
	type ReviewAction,
	type ReviewViewState,
	renderReview,
	reviewKey,
} from "./review-model.ts";

/** Multi-select screen; resolves with the chosen indices or undefined when cancelled. */
export function chooseMany(
	ui: UiPort,
	title: string,
	items: readonly string[],
	preselected: number[] = [],
): Promise<number[] | undefined> {
	return ui.screen<number[] | undefined>((requestRender, styler, done) => {
		let state = initialChecklist(preselected);
		return {
			render: (width) => renderChecklist(title, items, state, width, styler),
			handleInput: (data) => {
				const result = checklistKey(state, data, items.length);
				if (!result.done) {
					state = result.state;
					requestRender();
				} else done("cancelled" in result ? undefined : result.selected);
			},
			invalidate: () => {},
		};
	});
}

function browse(
	ui: UiPort,
	session: ReviewSession,
	state: ReviewViewState,
	evidence: CodeEvidenceFile | undefined,
): Promise<{ action: ReviewAction; state: ReviewViewState }> {
	return ui.screen((requestRender, styler, done) => {
		let current = state;
		return {
			render: (width) => renderReview(session, current, evidence, width, styler),
			handleInput: (data) => {
				const result = reviewKey(current, data, session.list());
				current = result.state;
				if (result.action) done({ action: result.action, state: current });
				else requestRender();
			},
			invalidate: () => {},
		};
	});
}

const labelOf = (c: ClusterView) => `${c.entry.label} (${c.codes.length})`;

/** Performs one editing action with dialogs; returns a status message for the screen. */
async function perform(
	ui: UiPort,
	session: ReviewSession,
	action: ReviewAction,
	state: ReviewViewState,
): Promise<string | undefined> {
	const clusters = session.list();
	const current = clusters[state.clusterIndex];
	if (!current) return action === "create" ? undefined : "No clusters left.";
	const others = clusters.filter((c) => c.id !== current.id && c.entry.status !== "drop");

	switch (action) {
		case "rename": {
			const label = await ui.input(`Rename "${current.entry.label}"`, current.entry.label);
			if (label === undefined) return undefined;
			session.rename(current.id, label);
			return `Renamed to "${label.trim()}".`;
		}
		case "describe": {
			const text = await ui.editor(`Description for "${current.entry.label}"`, current.entry.description);
			if (text === undefined) return undefined;
			session.describe(current.id, text.trim());
			return "Description updated.";
		}
		case "flag":
			session.toggleNeedsEvidence(current.id);
			return session.get(current.id).entry.needs_more_evidence
				? "Flagged for more evidence (refinement will leave it untouched)."
				: "Flag cleared.";
		case "merge": {
			const picked = await chooseMany(ui, `Merge into "${current.entry.label}"`, others.map(labelOf));
			if (!picked?.length) return undefined;
			const label = await ui.input("Label for the merged cluster", current.entry.label);
			if (label === undefined) return undefined;
			session.merge(
				picked.map((i) => others[i]!.id),
				current.id,
				label,
			);
			return `Merged ${picked.length} cluster(s) into "${label.trim() || current.entry.label}".`;
		}
		case "split": {
			const picked = await chooseMany(ui, `Codes to split out of "${current.entry.label}"`, [...current.codes]);
			if (!picked?.length) return undefined;
			const label = await ui.input("Label for the new cluster");
			if (label === undefined) return undefined;
			session.split(
				current.id,
				picked.map((i) => current.codes[i]!),
				label,
			);
			return `Split ${picked.length} code(s) into "${label.trim()}".`;
		}
		case "move": {
			const codes =
				state.focus === "codes" && current.codes[state.codeIndex] !== undefined
					? [current.codes[state.codeIndex]!]
					: ((await chooseMany(ui, `Codes to move out of "${current.entry.label}"`, [...current.codes]))?.map(
							(i) => current.codes[i]!,
						) ?? []);
			if (codes.length === 0) return undefined;
			const target = await ui.select(`Move ${codes.length} code(s) to`, others.map(labelOf));
			if (target === undefined) return undefined;
			session.moveCodes(codes, others[others.map(labelOf).indexOf(target)]!.id);
			return `Moved ${codes.length} code(s).`;
		}
		case "drop": {
			if (current.entry.status === "drop") {
				session.restore(current.id);
				return `Restored "${current.entry.label}".`;
			}
			const choice = await ui.select(`Drop "${current.entry.label}"?`, [
				"Drop and delete its codes",
				"Drop but keep its codes as orphans",
			]);
			if (choice === undefined) return undefined;
			session.drop(current.id, choice.includes("orphans") ? "orphan" : "delete");
			return `Dropped "${current.entry.label}".`;
		}
		case "create": {
			const label = await ui.input("Label for the new (human-authored) cluster");
			if (label === undefined) return undefined;
			const picked = await chooseMany(ui, `Codes from "${current.entry.label}" to move into it (optional)`, [
				...current.codes,
			]);
			session.create(
				label,
				(picked ?? []).map((i) => current.codes[i]!),
			);
			return `Created "${label.trim()}".`;
		}
		case "undo":
			return session.undo() ? "Undid the last edit." : "Nothing to undo.";
		default:
			return undefined;
	}
}

export type ReviewFlowResult = { approved: true; payload: EnrichedCodebook } | { approved: false };

/**
 * Interactive codebook review (paper §3.1 / Appendix G): browse clusters least-confident first,
 * edit with provenance, then approve or cancel.
 */
export async function runReviewFlow(
	ui: UiPort,
	session: ReviewSession,
	evidence?: CodeEvidenceFile,
): Promise<ReviewFlowResult> {
	let state = initialReviewState();
	for (;;) {
		state = clampReviewState(state, session.list());
		const result = await browse(ui, session, state, evidence);
		state = result.state;
		if (result.action === "approve") {
			const s = session.stats();
			const ok = await ui.confirm(
				"Approve this codebook?",
				`${s.kept} clusters kept, ${s.dropped} dropped, ${s.edited} edited, ${s.flagged} flagged for more evidence. The pipeline continues with refinement.`,
			);
			if (ok) return { approved: true, payload: session.toPayload() };
			continue;
		}
		if (result.action === "cancel") {
			if (
				session.editCount === 0 ||
				(await ui.confirm("Leave the review?", `Discard ${session.editCount} unsaved edit(s)?`))
			) {
				return { approved: false };
			}
			continue;
		}
		const selectedId = session.list()[state.clusterIndex]?.id;
		try {
			state = { ...state, message: await perform(ui, session, result.action, state) };
		} catch (error) {
			if (!(error instanceof CodebookReviewError)) throw error;
			state = { ...state, message: error.message };
		}
		const followed = session.list().findIndex((c) => c.id === selectedId);
		if (followed !== -1) state = { ...state, clusterIndex: followed };
	}
}

export interface JudgeFlowResult {
	judged: number;
	skipped: number;
	stopped: boolean;
}

/** Blind human judging of disagreement items, recording each verdict as soon as it is given. */
export async function runJudgeFlow(
	ui: UiPort,
	items: readonly DisagreementItem[],
	options: {
		annotator: string;
		outcomes: JudgeOutcomes;
		record: (item: DisagreementItem, verdict: Verdict) => Promise<void>;
	},
): Promise<JudgeFlowResult> {
	let judged = 0;
	let skipped = 0;
	for (const [index, item] of items.entries()) {
		const result = await ui.screen<JudgeKeyResult>((_requestRender, styler, done) => ({
			render: (width) =>
				renderJudgeItem(
					item,
					{ index, total: items.length, annotator: options.annotator },
					options.outcomes,
					width,
					styler,
				),
			handleInput: (data) => {
				const key = judgeKey(data, options.outcomes);
				if (key.kind !== "none") done(key);
			},
			invalidate: () => {},
		}));
		if (result.kind === "quit") return { judged, skipped, stopped: true };
		if (result.kind === "skip") {
			skipped++;
			continue;
		}
		if (result.kind === "verdict") {
			await options.record(item, result.verdict);
			judged++;
		}
	}
	return { judged, skipped, stopped: false };
}
