import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alphaFromCoderRows, krippendorffAlphaNominal, percentAgreement } from "../../src/evaluation/krippendorff.ts";

const reference = JSON.parse(
	readFileSync(new URL("../fixtures/reference/krippendorff.json", import.meta.url), "utf8"),
) as {
	paper: { data: Array<Array<number | null>>; alpha: number };
	cases: Array<{ data: Array<Array<number | null>>; alpha: number }>;
};

describe("Krippendorff's alpha (nominal)", () => {
	it("reproduces the worked example in Krippendorff (2011): 0.743", () => {
		expect(alphaFromCoderRows(reference.paper.data)).toBeCloseTo(0.743, 3);
		expect(alphaFromCoderRows(reference.paper.data)).toBeCloseTo(reference.paper.alpha, 12);
	});

	it.each(reference.cases.map((c, i) => [i, c] as const))(
		"matches the krippendorff package on random case %i",
		(_i, c) => {
			expect(alphaFromCoderRows(c.data)).toBeCloseTo(c.alpha, 12);
		},
	);

	it("is 1 for perfect agreement and handles string categories", () => {
		expect(
			krippendorffAlphaNominal([
				["A", "A"],
				["B", "B"],
				["NONE", "NONE"],
			]),
		).toBe(1);
	});

	it("ignores units with fewer than two values", () => {
		const base = [
			["A", "A"],
			["B", "B"],
			["A", "B"],
		];
		expect(krippendorffAlphaNominal([...base, ["A", null], [undefined, undefined]])).toBe(
			krippendorffAlphaNominal(base),
		);
	});

	it("is undefined with a single category or no pairable data", () => {
		expect(
			krippendorffAlphaNominal([
				["A", "A"],
				["A", "A"],
			]),
		).toBeNaN();
		expect(krippendorffAlphaNominal([["A", null]])).toBeNaN();
		expect(krippendorffAlphaNominal([])).toBeNaN();
	});

	it("goes negative for systematic disagreement", () => {
		expect(
			krippendorffAlphaNominal([
				["A", "B"],
				["B", "A"],
				["A", "B"],
			]),
		).toBeLessThan(0);
	});
});

describe("percentAgreement", () => {
	it("counts matching pairs", () => {
		expect(
			percentAgreement([
				["A", "A"],
				["A", "B"],
			]),
		).toBe(0.5);
		expect(percentAgreement([])).toBeNaN();
	});
});
