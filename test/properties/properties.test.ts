import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { kmeans } from "../../src/cluster/kmeans.ts";
import { mapConcurrent } from "../../src/core/concurrency.ts";
import { parseJsonResponse } from "../../src/core/json.ts";
import { Rng } from "../../src/core/random.ts";
import { Matrix } from "../../src/embeddings/vector.ts";
import { krippendorffAlphaNominal } from "../../src/evaluation/krippendorff.ts";
import { assignMissingClusters, metaThemeBounds, normalizeMetaThemeCount } from "../../src/hierarchy/meta.ts";
import { applyCodebookReview, CodebookReviewError } from "../../src/review/apply.ts";
import { buildV1 } from "../../src/review/schema.ts";
import { ReviewSession } from "../../src/review/session.ts";

const RUNS = { numRuns: 200 };

type Edit =
	| { kind: "rename"; c: number; label: string }
	| { kind: "move"; code: number; target: number }
	| { kind: "merge"; a: number; b: number }
	| { kind: "split"; c: number; take: number }
	| { kind: "drop"; c: number; orphan: boolean }
	| { kind: "restore"; c: number }
	| { kind: "create"; code: number }
	| { kind: "flag"; c: number }
	| { kind: "undo" };

const editArb: fc.Arbitrary<Edit> = fc.oneof(
	fc.record({
		kind: fc.constant("rename" as const),
		c: fc.nat(10),
		label: fc.string({ minLength: 1, maxLength: 12 }),
	}),
	fc.record({ kind: fc.constant("move" as const), code: fc.nat(30), target: fc.nat(10) }),
	fc.record({ kind: fc.constant("merge" as const), a: fc.nat(10), b: fc.nat(10) }),
	fc.record({ kind: fc.constant("split" as const), c: fc.nat(10), take: fc.integer({ min: 1, max: 4 }) }),
	fc.record({ kind: fc.constant("drop" as const), c: fc.nat(10), orphan: fc.boolean() }),
	fc.record({ kind: fc.constant("restore" as const), c: fc.nat(10) }),
	fc.record({ kind: fc.constant("create" as const), code: fc.nat(30) }),
	fc.record({ kind: fc.constant("flag" as const), c: fc.nat(10) }),
	fc.constant({ kind: "undo" as const }),
);

function initialProposal(sizes: number[]) {
	const codebook: Record<string, string> = {};
	const ctc: Record<string, string[]> = {};
	let n = 0;
	sizes.forEach((size, i) => {
		codebook[String(i)] = `Theme ${i}`;
		ctc[String(i)] = Array.from({ length: size }, () => `code-${n++}`);
	});
	return { proposal: buildV1(codebook, ctc), codes: Object.values(ctc).flat() };
}

function applyEdit(session: ReviewSession, edit: Edit, codes: readonly string[]): void {
	const clusters = session.list();
	const pick = (i: number) => clusters[i % clusters.length]!;
	try {
		switch (edit.kind) {
			case "rename":
				session.rename(pick(edit.c).id, edit.label);
				break;
			case "move": {
				const code = codes[edit.code % codes.length]!;
				if (session.clusterOf(code) !== undefined) session.moveCodes([code], pick(edit.target).id);
				break;
			}
			case "merge":
				session.merge([pick(edit.b).id], pick(edit.a).id);
				break;
			case "split": {
				const c = pick(edit.c);
				session.split(c.id, c.codes.slice(0, edit.take), "Split");
				break;
			}
			case "drop":
				session.drop(pick(edit.c).id, edit.orphan ? "orphan" : "delete");
				break;
			case "restore":
				session.restore(pick(edit.c).id);
				break;
			case "create": {
				const code = codes[edit.code % codes.length]!;
				session.create("New", session.clusterOf(code) !== undefined ? [code] : []);
				break;
			}
			case "flag":
				session.toggleNeedsEvidence(pick(edit.c).id);
				break;
			case "undo":
				session.undo();
				break;
		}
	} catch (error) {
		if (!(error instanceof CodebookReviewError)) throw error;
	}
}

describe("review session properties", () => {
	it("any edit sequence yields a payload that applies cleanly and conserves codes", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 6 }),
				fc.array(editArb, { maxLength: 25 }),
				(sizes, edits) => {
					const { proposal, codes } = initialProposal(sizes);
					const session = new ReviewSession(proposal);
					for (const edit of edits) applyEdit(session, edit, codes);
					const result = applyCodebookReview(session.toPayload(), { cluster_to_codes: proposal.cluster_to_codes });

					const kept = Object.values(result.clusterToCodes).flat();
					expect(new Set(kept).size).toBe(kept.length);
					const accounted = new Set([...kept, ...result.orphanedCodes]);
					for (const code of accounted) expect(codes).toContain(code);
					const deletedByDrop = session
						.toPayload()
						.operations.filter((op) => op.type === "drop" && op.code_disposition === "delete").length;
					if (deletedByDrop === 0) expect(accounted.size).toBe(codes.length);
					expect(Object.keys(result.codebook)).toEqual(Object.keys(result.clusterToCodes));
					expect(Object.keys(result.codebook)).toEqual(Object.keys(result.codebook).map((_, i) => String(i)));
				},
			),
			RUNS,
		);
	});

	it("undo restores the exact previous payload", () => {
		fc.assert(
			fc.property(fc.array(editArb, { minLength: 1, maxLength: 15 }), (edits) => {
				const { proposal, codes } = initialProposal([3, 3, 2]);
				const session = new ReviewSession(proposal);
				for (const edit of edits) {
					const before = JSON.stringify(session.toPayload());
					const editsBefore = session.editCount;
					applyEdit(session, edit, codes);
					if (edit.kind !== "undo" && session.editCount > editsBefore) {
						session.undo();
						expect(JSON.stringify(session.toPayload())).toBe(before);
						applyEdit(session, edit, codes);
					}
				}
			}),
			{ numRuns: 100 },
		);
	});
});

describe("Krippendorff's alpha properties", () => {
	const unitsArb = fc.array(
		fc.array(fc.option(fc.constantFrom("a", "b", "c", "d"), { nil: null }), { minLength: 2, maxLength: 4 }),
		{
			minLength: 2,
			maxLength: 30,
		},
	);

	it("is invariant to renaming categories and reordering units or coders", () => {
		fc.assert(
			fc.property(unitsArb, fc.integer(), (units, seed) => {
				const alpha = krippendorffAlphaNominal(units);
				const rename: Record<string, string> = { a: "x", b: "y", c: "z", d: "w" };
				const renamed = units.map((u) => u.map((v) => (v === null ? null : rename[v]!)));
				const rng = new Rng(seed);
				const shuffled = rng.shuffle(units).map((u) => rng.shuffle(u));
				for (const other of [krippendorffAlphaNominal(renamed), krippendorffAlphaNominal(shuffled)]) {
					if (Number.isNaN(alpha)) expect(other).toBeNaN();
					else expect(other).toBeCloseTo(alpha, 10);
				}
			}),
			RUNS,
		);
	});

	it("never exceeds 1 and is 1 for perfect agreement over several categories", () => {
		fc.assert(
			fc.property(unitsArb, (units) => {
				const alpha = krippendorffAlphaNominal(units);
				if (!Number.isNaN(alpha)) expect(alpha).toBeLessThanOrEqual(1 + 1e-12);
				const perfect = units.map((u, i) => u.map(() => ["a", "b"][i % 2]!));
				expect(krippendorffAlphaNominal(perfect)).toBe(1);
			}),
			RUNS,
		);
	});
});

describe("meta-theme repair properties", () => {
	it("always lands inside the bounds when possible and never loses a cluster", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 40 }),
				fc.integer({ min: 1, max: 15 }),
				fc.integer(),
				(clusters, groups, seed) => {
					const ids = Array.from({ length: clusters }, (_, i) => String(i));
					const rng = new Rng(seed);
					const metas = Array.from({ length: Math.min(groups, clusters) }, (_, g) => ({
						name: `M${g}`,
						cluster_ids: [] as string[],
					}));
					for (const id of rng.shuffle(ids)) metas[rng.int(metas.length)]!.cluster_ids.push(id);
					assignMissingClusters(metas, ids);
					const repaired = normalizeMetaThemeCount(metas, clusters);
					expect(repaired.flatMap((m) => m.cluster_ids).sort()).toEqual([...ids].sort());
					const [lo, hi] = metaThemeBounds(clusters);
					expect(repaired.length).toBeLessThanOrEqual(Math.max(hi, 1));
					if (clusters >= lo) expect(repaired.length).toBeGreaterThanOrEqual(Math.min(lo, clusters));
				},
			),
			RUNS,
		);
	});
});

describe("k-means properties", () => {
	it("assigns every point to its nearest center with labels in range", () => {
		fc.assert(
			fc.property(
				fc.array(fc.array(fc.double({ min: -5, max: 5, noNaN: true }), { minLength: 3, maxLength: 3 }), {
					minLength: 4,
					maxLength: 30,
				}),
				fc.integer({ min: 1, max: 4 }),
				fc.integer(),
				(rows, k, seed) => {
					const m = Matrix.fromRows(rows);
					const result = kmeans(m, Math.min(k, rows.length), { rng: new Rng(seed), nInit: 2 });
					const kk = Math.min(k, rows.length);
					for (let i = 0; i < rows.length; i++) {
						const label = result.labels[i]!;
						expect(label).toBeGreaterThanOrEqual(0);
						expect(label).toBeLessThan(kk);
						const dist = (c: number) =>
							rows[i]!.reduce((s, v, d) => s + (v - result.centers[c * 3 + d]!) ** 2, 0);
						for (let c = 0; c < kk; c++) expect(dist(label)).toBeLessThanOrEqual(dist(c) + 1e-6);
					}
				},
			),
			{ numRuns: 100 },
		);
	});
});

describe("infrastructure properties", () => {
	it("mapConcurrent returns results in input order for any limit", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.nat(5), { maxLength: 30 }),
				fc.integer({ min: 1, max: 8 }),
				async (delays, limit) => {
					const out = await mapConcurrent(delays, limit, async (d, i) => {
						await new Promise((r) => setTimeout(r, d));
						return i;
					});
					expect(out).toEqual(delays.map((_, i) => i));
				},
			),
			{ numRuns: 50 },
		);
	});

	it("parseJsonResponse recovers any object wrapped in noise and fences", () => {
		fc.assert(
			fc.property(
				fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
				fc.string().filter((s) => !s.includes("{")),
				(object, noise) => {
					const text = `${noise}\n\`\`\`json\n${JSON.stringify(object)}\n\`\`\`\n`;
					expect(parseJsonResponse(text)).toEqual(object);
				},
			),
			RUNS,
		);
	});
});
