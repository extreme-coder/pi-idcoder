import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { CodeEvidenceFile } from "../evidence/code-evidence.ts";
import type { ClusterView, ReviewSession } from "../review/session.ts";
import { clip, pad, rule, type Styler, scrollWindow, wrap } from "./styler.ts";

export type ReviewAction =
	| "rename"
	| "describe"
	| "flag"
	| "merge"
	| "split"
	| "move"
	| "drop"
	| "create"
	| "undo"
	| "approve"
	| "cancel";

export interface ReviewViewState {
	clusterIndex: number;
	clusterOffset: number;
	codeIndex: number;
	codeOffset: number;
	focus: "clusters" | "codes";
	message?: string | undefined;
}

export const LIST_ROWS = 12;
export const CODE_ROWS = 10;

export function initialReviewState(): ReviewViewState {
	return { clusterIndex: 0, clusterOffset: 0, codeIndex: 0, codeOffset: 0, focus: "clusters" };
}

const ACTION_KEYS: Array<[KeyId, ReviewAction]> = [
	["r", "rename"],
	["e", "describe"],
	["f", "flag"],
	["m", "merge"],
	["s", "split"],
	["x", "move"],
	["d", "drop"],
	["n", "create"],
	["u", "undo"],
	["a", "approve"],
];

/** Pure key handling: returns the next view state and, for editing keys, the requested action. */
export function reviewKey(
	state: ReviewViewState,
	data: string,
	clusters: readonly ClusterView[],
): { state: ReviewViewState; action?: ReviewAction } {
	const next = { ...state, message: undefined };
	if (matchesKey(data, "escape") || matchesKey(data, "q")) return { state: next, action: "cancel" };
	if (matchesKey(data, "tab")) {
		next.focus = state.focus === "clusters" ? "codes" : "clusters";
		return { state: next };
	}
	const step =
		matchesKey(data, "up") || matchesKey(data, "k") ? -1 : matchesKey(data, "down") || matchesKey(data, "j") ? 1 : 0;
	const page = matchesKey(data, "pageUp") ? -1 : matchesKey(data, "pageDown") ? 1 : 0;
	if (step || page) {
		if (next.focus === "clusters") {
			const size = page ? LIST_ROWS : 1;
			next.clusterIndex = Math.max(0, Math.min(clusters.length - 1, state.clusterIndex + (step || page) * size));
			next.clusterOffset = scrollWindow(next.clusterIndex, state.clusterOffset, LIST_ROWS, clusters.length);
			next.codeIndex = 0;
			next.codeOffset = 0;
		} else {
			const codes = clusters[state.clusterIndex]?.codes.length ?? 0;
			const size = page ? CODE_ROWS : 1;
			next.codeIndex = Math.max(0, Math.min(codes - 1, state.codeIndex + (step || page) * size));
			next.codeOffset = scrollWindow(next.codeIndex, state.codeOffset, CODE_ROWS, codes);
		}
		return { state: next };
	}
	for (const [key, action] of ACTION_KEYS) if (matchesKey(data, key)) return { state: next, action };
	return { state: next };
}

/** Keeps indices valid after edits change the cluster list (e.g. after a merge or drop). */
export function clampReviewState(state: ReviewViewState, clusters: readonly ClusterView[]): ReviewViewState {
	const clusterIndex = Math.max(0, Math.min(state.clusterIndex, clusters.length - 1));
	const codes = clusters[clusterIndex]?.codes.length ?? 0;
	const codeIndex = Math.max(0, Math.min(state.codeIndex, codes - 1));
	return {
		...state,
		clusterIndex,
		clusterOffset: scrollWindow(clusterIndex, state.clusterOffset, LIST_ROWS, clusters.length),
		codeIndex,
		codeOffset: scrollWindow(codeIndex, state.codeOffset, CODE_ROWS, codes),
	};
}

function confidenceBadge(styler: Styler, confidence: number): string {
	const color = confidence <= 2 ? "warning" : confidence >= 4 ? "success" : "muted";
	return styler.fg(
		color,
		`${"●".repeat(Math.max(0, Math.min(5, confidence)))}${"○".repeat(Math.max(0, 5 - confidence))}`,
	);
}

function provenanceTag(styler: Styler, cluster: ClusterView): string {
	const tags: string[] = [];
	if (cluster.entry.status === "drop") tags.push(styler.fg("error", "dropped"));
	if (cluster.entry.source === "human") tags.push(styler.fg("accent", "human"));
	if (cluster.entry.source === "llm+edited") tags.push(styler.fg("accent", "edited"));
	if (cluster.entry.needs_more_evidence) tags.push(styler.fg("warning", "needs evidence"));
	return tags.join(" ");
}

/** Renders the review screen: cluster list, selected cluster detail with codes and evidence, key help. */
export function renderReview(
	session: ReviewSession,
	state: ReviewViewState,
	evidence: CodeEvidenceFile | undefined,
	width: number,
	styler: Styler,
): string[] {
	const clusters = session.list();
	const stats = session.stats();
	const lines: string[] = [];
	lines.push(
		rule(
			styler,
			width,
			`Codebook review · ${stats.kept} kept · ${stats.dropped} dropped · ${stats.edited} edited · ${stats.lowConfidence} low-confidence`,
		),
	);

	const labelWidth = Math.max(10, width - 24);
	clusters.slice(state.clusterOffset, state.clusterOffset + LIST_ROWS).forEach((cluster, i) => {
		const index = state.clusterOffset + i;
		const selected = index === state.clusterIndex;
		const marker = selected ? styler.fg("accent", state.focus === "clusters" ? "▶ " : "▷ ") : "  ";
		const label = cluster.entry.status === "drop" ? styler.fg("dim", cluster.entry.label) : cluster.entry.label;
		const row = `${marker}${confidenceBadge(styler, cluster.entry.confidence)} ${pad(clip(label, labelWidth - 8), labelWidth - 8)} ${styler.fg("muted", `${cluster.codes.length} codes`)}`;
		lines.push(selected ? styler.bg("selectedBg", pad(row, width)) : clip(row, width));
	});
	if (clusters.length > LIST_ROWS) {
		lines.push(
			clip(
				styler.fg(
					"dim",
					`  ${state.clusterOffset + 1}–${Math.min(clusters.length, state.clusterOffset + LIST_ROWS)} of ${clusters.length}`,
				),
				width,
			),
		);
	}

	const current = clusters[state.clusterIndex];
	if (current) {
		lines.push(rule(styler, width, `Cluster ${current.id}`));
		lines.push(clip(`${styler.bold(current.entry.label)}  ${provenanceTag(styler, current)}`, width));
		if (current.entry.description) lines.push(...wrap(styler.fg("muted", current.entry.description), width, "  "));
		const visible = current.codes.slice(state.codeOffset, state.codeOffset + CODE_ROWS);
		visible.forEach((code, i) => {
			const index = state.codeOffset + i;
			const active = state.focus === "codes" && index === state.codeIndex;
			const quotes = evidence?.by_open_code[code]?.quote_count;
			const row = `${active ? styler.fg("accent", "› ") : "  "}${code}${quotes ? styler.fg("dim", ` (${quotes})`) : ""}`;
			lines.push(active ? styler.bg("selectedBg", pad(clip(row, width), width)) : clip(row, width));
		});
		if (current.codes.length > CODE_ROWS) {
			lines.push(
				clip(
					styler.fg(
						"dim",
						`  codes ${state.codeOffset + 1}–${Math.min(current.codes.length, state.codeOffset + CODE_ROWS)} of ${current.codes.length}`,
					),
					width,
				),
			);
		}
		const focusCode = current.codes[state.focus === "codes" ? state.codeIndex : 0];
		const quote = focusCode ? evidence?.by_open_code[focusCode]?.primary?.quote : undefined;
		if (quote) lines.push(...wrap(styler.fg("muted", `“${quote}”`), width, "    "));
	}

	if (state.message) lines.push(styler.fg("warning", clip(state.message, width)));
	lines.push(rule(styler, width));
	lines.push(
		...wrap(
			styler.fg(
				"dim",
				"↑↓ move · tab codes · r rename · e describe · f flag · m merge · s split · x move codes · d drop/restore · n new · u undo · a approve · esc cancel",
			),
			width,
		),
	);
	return lines;
}
