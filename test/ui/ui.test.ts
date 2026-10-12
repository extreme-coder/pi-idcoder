import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { DisagreementItem, Verdict } from "../../src/evaluation/types.ts";
import type { CodeEvidenceFile } from "../../src/evidence/code-evidence.ts";
import { applyCodebookReview } from "../../src/review/apply.ts";
import { buildV1 } from "../../src/review/schema.ts";
import { ReviewSession } from "../../src/review/session.ts";
import { checklistKey, initialChecklist, renderChecklist } from "../../src/ui/checklist.ts";
import { chooseMany, runJudgeFlow, runReviewFlow } from "../../src/ui/flows.ts";
import { judgeKey, renderJudgeItem } from "../../src/ui/judge-model.ts";
import { clampReviewState, initialReviewState, LIST_ROWS, renderReview, reviewKey } from "../../src/ui/review-model.ts";
import { plainStyler, scrollWindow } from "../../src/ui/styler.ts";
import { FakeUi, KEYS } from "../helpers/fake-ui.ts";

function session(clusterCount = 3): ReviewSession {
	const codebook: Record<string, string> = {};
	const ctc: Record<string, string[]> = {};
	const confidence: Record<string, { label: string; confidence: number; rationale: string }> = {};
	for (let i = 0; i < clusterCount; i++) {
		codebook[String(i)] = `Theme ${i}`;
		ctc[String(i)] = [`code ${i}a`, `code ${i}b`, `code ${i}c`];
		confidence[String(i)] = { label: `Theme ${i}`, confidence: (i % 5) + 1, rationale: `why ${i}` };
	}
	return new ReviewSession(buildV1(codebook, ctc, confidence));
}

const evidence: CodeEvidenceFile = {
	version: 1,
	slug: "s",
	research_question: "",
	generated_at: "",
	by_open_code: {
		"code 0a": {
			quote_count: 2,
			review_count: 2,
			primary: { snippet_id: "S1", review_id: 1, source_id: null, quote: "the game froze", note: "" },
			snippets: [],
		},
	},
};

describe("review screen model", () => {
	it("navigates clusters and codes and maps keys to actions", () => {
		const clusters = session(20).list();
		let state = initialReviewState();
		state = reviewKey(state, KEYS.down, clusters).state;
		state = reviewKey(state, "j", clusters).state;
		expect(state.clusterIndex).toBe(2);
		state = reviewKey(state, KEYS.pageDown, clusters).state;
		expect(state.clusterIndex).toBe(2 + LIST_ROWS);
		expect(state.clusterOffset).toBeGreaterThan(0);
		state = reviewKey(state, KEYS.tab, clusters).state;
		expect(state.focus).toBe("codes");
		state = reviewKey(state, KEYS.down, clusters).state;
		expect(state.codeIndex).toBe(1);
		expect(reviewKey(state, "r", clusters).action).toBe("rename");
		expect(reviewKey(state, "a", clusters).action).toBe("approve");
		expect(reviewKey(state, KEYS.escape, clusters).action).toBe("cancel");
		expect(reviewKey(state, "z", clusters).action).toBeUndefined();
	});

	it("clamps state after the list shrinks", () => {
		const clusters = session(2).list();
		expect(clampReviewState({ ...initialReviewState(), clusterIndex: 9, codeIndex: 9 }, clusters)).toMatchObject({
			clusterIndex: 1,
			codeIndex: 2,
		});
	});

	it("renders least-confident clusters first, with evidence and help, within the width", () => {
		const s = session(3);
		s.toggleNeedsEvidence("0");
		const lines = renderReview(s, { ...initialReviewState(), focus: "codes" }, evidence, 60, plainStyler);
		const text = lines.join("\n");
		expect(lines[1]).toContain("Theme 0");
		expect(text).toContain("needs evidence");
		expect(text).toContain("code 0a (2)");
		expect(text).toContain("“the game froze”");
		expect(text).toContain("a approve");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	it.each([20, 40, 80, 200])("never exceeds a %i-column terminal on any screen", (width) => {
		const s = session(15);
		s.rename("3", "A very long label ".repeat(10));
		const screens = [
			renderReview(s, initialReviewState(), evidence, width, plainStyler),
			renderReview(
				s,
				{ ...initialReviewState(), focus: "codes", message: "x".repeat(300) },
				evidence,
				width,
				plainStyler,
			),
			renderChecklist("Pick ".repeat(30), ["code ".repeat(40)], initialChecklist(), width, plainStyler),
			renderJudgeItem(
				{ ...item, quote: "q ".repeat(200) },
				{ index: 0, total: 1, annotator: "a".repeat(80) },
				"binary",
				width,
				plainStyler,
			),
		];
		for (const line of screens.flat()) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("scrolls windows to keep the cursor visible", () => {
		expect(scrollWindow(0, 0, 5, 3)).toBe(0);
		expect(scrollWindow(7, 0, 5, 20)).toBe(3);
		expect(scrollWindow(2, 5, 5, 20)).toBe(2);
		expect(scrollWindow(6, 5, 5, 20)).toBe(5);
	});
});

describe("checklist", () => {
	it("toggles, selects all, confirms, and cancels", () => {
		let state = initialChecklist([2]);
		let r = checklistKey(state, KEYS.space, 3);
		state = r.done ? state : r.state;
		r = checklistKey(state, KEYS.down, 3);
		state = r.done ? state : r.state;
		expect(state.cursor).toBe(1);
		expect(checklistKey(state, KEYS.enter, 3)).toEqual({ done: true, selected: [0, 2] });
		r = checklistKey(state, "*", 3);
		expect(!r.done && r.state.checked.size).toBe(3);
		expect(checklistKey(state, KEYS.escape, 3)).toEqual({ done: true, cancelled: true });
		expect(renderChecklist("Pick", ["a", "b", "c"], state, 40, plainStyler).join("\n")).toContain("[x] a");
	});

	it("chooseMany resolves through a screen", async () => {
		const ui = new FakeUi({ keys: [[KEYS.down, KEYS.space, KEYS.enter], [KEYS.escape]] });
		expect(await chooseMany(ui, "t", ["x", "y"])).toEqual([1]);
		expect(await chooseMany(ui, "t", ["x", "y"])).toBeUndefined();
	});
});

describe("review flow", () => {
	it("supports a full editing session and approves a payload that applies cleanly", async () => {
		const s = session(3);
		const ui = new FakeUi({
			keys: [
				["r"],
				["e"],
				["f"],
				[KEYS.tab, KEYS.down, "x"],
				["s"],
				[KEYS.space, KEYS.enter],
				[KEYS.tab, KEYS.down, "m"],
				[KEYS.space, KEYS.enter],
				["u"],
				["a"],
			],
			inputs: ["Renamed theme", "Split theme", "Merged theme"],
			editors: ["new description"],
			selects: ["Theme 1 (3)"],
			confirms: [true],
		});
		const result = await runReviewFlow(ui, s, evidence);
		expect(result.approved).toBe(true);
		if (!result.approved) return;
		const applied = applyCodebookReview(result.payload, { cluster_to_codes: {} });
		expect(Object.values(applied.codebook)).toContain("Renamed theme");
		expect(Object.values(applied.codebook)).toContain("Split theme");
		expect(Object.values(applied.clusterToCodes).flat().sort()).toHaveLength(9);
		expect(ui.dialogs).toContain("confirm:Approve this codebook?");
		expect(ui.renders.some((r) => r.join("\n").includes("Undid the last edit."))).toBe(true);
	});

	it("drops, restores, creates, and reports validation errors on screen", async () => {
		const s = session(2);
		const ui = new FakeUi({
			keys: [["d"], ["d"], ["n"], [KEYS.space, KEYS.enter], ["s"], ["*", KEYS.enter], [KEYS.escape]],
			selects: ["Drop but keep its codes as orphans"],
			inputs: ["Brand new", "too much"],
			confirms: [true],
		});
		expect(await runReviewFlow(ui, s)).toEqual({ approved: false });
		const text = ui.renders.map((r) => r.join("\n")).join("\n");
		expect(text).toContain("Dropped");
		expect(text).toContain("Restored");
		expect(text).toContain('Created "Brand new"');
		expect(text).toContain("A split must leave codes in the original cluster.");
		expect(ui.dialogs.at(-1)).toBe("confirm:Leave the review?");
	});

	it("cancels without confirmation when nothing changed, and keeps going if approval is declined", async () => {
		const ui = new FakeUi({ keys: [["a"], [KEYS.escape]], confirms: [false] });
		expect(await runReviewFlow(ui, session(1))).toEqual({ approved: false });
		expect(ui.dialogs).toEqual(["confirm:Approve this codebook?"]);
	});

	it("treats dismissed dialogs as no-ops", async () => {
		const ui = new FakeUi({ keys: [["r"], ["m"], [KEYS.escape], ["x"], [KEYS.escape], ["q"]], inputs: [undefined] });
		await runReviewFlow(ui, session(2));
		expect(ui.dialogs.filter((d) => d.startsWith("input")).length).toBe(1);
	});
});

const item: DisagreementItem = {
	item_id: "item_1",
	review_idx: 1,
	open_code: "c",
	quote: "Servers lag every night",
	option_a: { label: "Performance", definition: "Speed", inclusion: ["mentions lag"], exclusion: ["not price"] },
	option_b: { label: "Monetization", definition: "Prices", inclusion: [], exclusion: [] },
	true_side: "A",
	true_label: "Performance",
	pred_label: "Monetization",
	raised_by: ["m"],
};

describe("judging", () => {
	it("maps keys to verdicts for each outcome set", () => {
		expect(judgeKey("1", "binary")).toEqual({ kind: "verdict", verdict: "A" });
		expect(judgeKey("b", "binary")).toEqual({ kind: "verdict", verdict: "B" });
		expect(judgeKey("3", "binary")).toEqual({ kind: "none" });
		expect(judgeKey("3", "four_way")).toEqual({ kind: "verdict", verdict: "BOTH" });
		expect(judgeKey("n", "four_way")).toEqual({ kind: "verdict", verdict: "NEITHER" });
		expect(judgeKey("s", "four_way")).toEqual({ kind: "skip" });
		expect(judgeKey(KEYS.escape, "four_way")).toEqual({ kind: "quit" });
	});

	it("renders blind items without revealing the inductive side", () => {
		const lines = renderJudgeItem(item, { index: 0, total: 3, annotator: "alice" }, "four_way", 70, plainStyler);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
		const text = lines.join(" ");
		expect(text).toContain("Judge 1/3 · alice");
		expect(text).toContain("+ mentions lag");
		expect(text).toContain("3 both fit");
		expect(text).not.toMatch(/inductive|deductive|true_side/);
	});

	it("records verdicts, skips, and stops", async () => {
		const recorded: Array<[string, Verdict]> = [];
		const ui = new FakeUi({ keys: [["2"], ["s"], ["x", "4"], [KEYS.escape]] });
		const items = [
			item,
			{ ...item, item_id: "item_2" },
			{ ...item, item_id: "item_3" },
			{ ...item, item_id: "item_4" },
		];
		const result = await runJudgeFlow(ui, items, {
			annotator: "alice",
			outcomes: "four_way",
			record: async (i, v) => void recorded.push([i.item_id, v]),
		});
		expect(result).toEqual({ judged: 2, skipped: 1, stopped: true });
		expect(recorded).toEqual([
			["item_1", "B"],
			["item_3", "NEITHER"],
		]);
	});
});
