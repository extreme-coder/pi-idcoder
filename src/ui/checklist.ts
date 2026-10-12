import { matchesKey } from "@earendil-works/pi-tui";
import { fit, pad, rule, type Styler, scrollWindow, wrap } from "./styler.ts";

export interface ChecklistState {
	cursor: number;
	offset: number;
	checked: ReadonlySet<number>;
}

export type ChecklistResult =
	| { done: true; selected: number[] }
	| { done: true; cancelled: true }
	| { done: false; state: ChecklistState };

export const CHECKLIST_ROWS = 14;

export function initialChecklist(preselected: Iterable<number> = []): ChecklistState {
	return { cursor: 0, offset: 0, checked: new Set(preselected) };
}

/** Pure multi-select handling: ↑↓ move, space toggles, `*` toggles all, enter confirms, esc cancels. */
export function checklistKey(state: ChecklistState, data: string, count: number): ChecklistResult {
	if (matchesKey(data, "escape")) return { done: true, cancelled: true };
	if (matchesKey(data, "enter")) return { done: true, selected: [...state.checked].sort((a, b) => a - b) };
	const step =
		matchesKey(data, "up") || matchesKey(data, "k") ? -1 : matchesKey(data, "down") || matchesKey(data, "j") ? 1 : 0;
	if (step) {
		const cursor = Math.max(0, Math.min(count - 1, state.cursor + step));
		return {
			done: false,
			state: { ...state, cursor, offset: scrollWindow(cursor, state.offset, CHECKLIST_ROWS, count) },
		};
	}
	if (matchesKey(data, "space")) {
		const checked = new Set(state.checked);
		if (checked.has(state.cursor)) checked.delete(state.cursor);
		else checked.add(state.cursor);
		return { done: false, state: { ...state, checked } };
	}
	if (data === "*") {
		const all = state.checked.size === count;
		return {
			done: false,
			state: { ...state, checked: new Set(all ? [] : Array.from({ length: count }, (_, i) => i)) },
		};
	}
	return { done: false, state };
}

export function renderChecklist(
	title: string,
	items: readonly string[],
	state: ChecklistState,
	width: number,
	styler: Styler,
): string[] {
	const lines = [rule(styler, width, `${title} · ${state.checked.size} selected`)];
	items.slice(state.offset, state.offset + CHECKLIST_ROWS).forEach((item, i) => {
		const index = state.offset + i;
		const box = state.checked.has(index) ? styler.fg("success", "[x]") : styler.fg("muted", "[ ]");
		const row = `${index === state.cursor ? styler.fg("accent", "› ") : "  "}${box} ${item}`;
		lines.push(index === state.cursor ? styler.bg("selectedBg", pad(fit(row, width), width)) : fit(row, width));
	});
	if (items.length > CHECKLIST_ROWS) {
		lines.push(
			fit(
				styler.fg(
					"dim",
					`  ${state.offset + 1}–${Math.min(items.length, state.offset + CHECKLIST_ROWS)} of ${items.length}`,
				),
				width,
			),
		);
	}
	lines.push(
		rule(styler, width),
		...wrap(styler.fg("dim", "↑↓ move · space toggle · * all · enter confirm · esc cancel"), width),
	);
	return lines;
}
