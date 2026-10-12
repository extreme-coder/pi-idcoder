/**
 * Krippendorff's alpha for nominal data with any number of coders and missing values
 * (Krippendorff 2011, "Computing Krippendorff's Alpha-Reliability"): α = 1 − D_o / D_e, from the
 * coincidence matrix of pairable values. Only units coded by at least two coders contribute.
 *
 * `units[u]` lists the values the coders assigned to unit u; `null`/`undefined` mark missing.
 * Returns NaN when alpha is undefined (fewer than two pairable values, or a single category).
 */
export function krippendorffAlphaNominal(
	units: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>,
): number {
	const coincidence = new Map<string, Map<string, number>>();
	const add = (c: string, k: string, w: number) => {
		const row = coincidence.get(c) ?? new Map<string, number>();
		row.set(k, (row.get(k) ?? 0) + w);
		coincidence.set(c, row);
	};
	for (const unit of units) {
		const values = unit.filter((v): v is string | number => v !== null && v !== undefined).map(String);
		const m = values.length;
		if (m < 2) continue;
		for (let i = 0; i < m; i++) {
			for (let j = 0; j < m; j++) if (i !== j) add(values[i]!, values[j]!, 1 / (m - 1));
		}
	}
	const marginals = new Map<string, number>();
	let n = 0;
	let observedDisagreement = 0;
	for (const [c, row] of coincidence) {
		for (const [k, w] of row) {
			marginals.set(c, (marginals.get(c) ?? 0) + w);
			n += w;
			if (c !== k) observedDisagreement += w;
		}
	}
	if (n <= 1 || marginals.size < 2) return Number.NaN;
	let expectedDisagreement = 0;
	for (const [c, nc] of marginals) for (const [k, nk] of marginals) if (c !== k) expectedDisagreement += nc * nk;
	return 1 - ((n - 1) * observedDisagreement) / expectedDisagreement;
}

/** Convenience form: one row per coder, one column per unit (the layout of the `krippendorff` package). */
export function alphaFromCoderRows(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): number {
	const unitCount = Math.max(0, ...rows.map((r) => r.length));
	return krippendorffAlphaNominal(Array.from({ length: unitCount }, (_, u) => rows.map((r) => r[u])));
}

export function percentAgreement(pairs: ReadonlyArray<readonly [string, string]>): number {
	if (pairs.length === 0) return Number.NaN;
	return pairs.filter(([a, b]) => a === b).length / pairs.length;
}
