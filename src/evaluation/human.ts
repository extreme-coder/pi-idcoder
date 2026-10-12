import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonl, readJsonl } from "../core/fs.ts";
import { Rng } from "../core/random.ts";
import { type DisagreementItem, type EvalPaths, type HumanJudgment, preferenceOf, type Verdict } from "./types.ts";

function annotatorSeed(seed: number, annotator: string): number {
	let h = seed >>> 0;
	for (let i = 0; i < annotator.length; i++) h = Math.imul(h ^ annotator.charCodeAt(i), 0x01000193) >>> 0;
	return h;
}

/**
 * Items for one annotator: every annotator draws from the same seeded sample of the pool (so
 * inter-annotator agreement is computable), minus what they already judged, in their own order.
 */
export function itemsForAnnotator(
	pool: readonly DisagreementItem[],
	annotator: string,
	alreadyJudged: ReadonlySet<string>,
	count: number,
	seed: number,
): DisagreementItem[] {
	const shared = new Rng(seed).shuffle(pool).slice(0, count);
	const remaining = shared.filter((item) => !alreadyJudged.has(item.item_id));
	return new Rng(annotatorSeed(seed, annotator)).shuffle(remaining);
}

export function makeJudgment(item: DisagreementItem, annotator: string, verdict: Verdict): HumanJudgment {
	return {
		item_id: item.item_id,
		annotator,
		verdict,
		preferred: preferenceOf(verdict, item.true_side),
		ts: new Date().toISOString(),
	};
}

export async function recordJudgment(paths: EvalPaths, judgment: HumanJudgment): Promise<void> {
	await appendJsonl(paths.human(judgment.annotator), judgment);
}

/** Latest judgment per (annotator, item) across every annotator file. */
export async function loadHumanJudgments(paths: EvalPaths): Promise<HumanJudgment[]> {
	let files: string[];
	try {
		files = (await readdir(paths.humanDir)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const latest = new Map<string, HumanJudgment>();
	for (const file of files.sort()) {
		for (const judgment of await readJsonl<HumanJudgment>(join(paths.humanDir, file))) {
			latest.set(JSON.stringify([judgment.annotator, judgment.item_id]), judgment);
		}
	}
	return [...latest.values()];
}
