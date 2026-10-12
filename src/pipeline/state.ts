import { createHash } from "node:crypto";
import type { IdcoderConfig } from "../config/schema.ts";
import { readJsonIfExists, writeJson } from "../core/fs.ts";
import { STAGE_IDS, type StageId } from "./stage.ts";

export type StageStatus = "pending" | "running" | "done" | "skipped" | "paused" | "failed";

export interface StageRecord {
	status: StageStatus;
	startedAt?: string;
	finishedAt?: string;
	summary?: string;
	error?: string;
	metrics?: Record<string, number | string>;
}

export interface RunState {
	version: 1;
	slug: string;
	researchQuestion: string;
	createdAt: string;
	updatedAt: string;
	configHash: string;
	stages: Record<StageId, StageRecord>;
}

/** Hash of the settings that change pipeline outputs, so a resumed run can warn about drift. */
export function configHash(config: IdcoderConfig): string {
	const { review: _review, viewer: _viewer, evaluation: _evaluation, ...relevant } = config;
	return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 16);
}

export function freshState(slug: string, config: IdcoderConfig): RunState {
	const now = new Date().toISOString();
	return {
		version: 1,
		slug,
		researchQuestion: config.study.researchQuestion,
		createdAt: now,
		updatedAt: now,
		configHash: configHash(config),
		stages: Object.fromEntries(STAGE_IDS.map((id) => [id, { status: "pending" }])) as Record<StageId, StageRecord>,
	};
}

export async function loadState(path: string): Promise<RunState | undefined> {
	const state = await readJsonIfExists<RunState>(path);
	if (!state) return undefined;
	for (const id of STAGE_IDS) state.stages[id] ??= { status: "pending" };
	return state;
}

export async function saveState(path: string, state: RunState): Promise<void> {
	state.updatedAt = new Date().toISOString();
	await writeJson(path, state);
}

/** Resets a stage and everything after it, so `from` re-runs downstream work on fresh inputs. */
export function resetFrom(state: RunState, from: StageId): void {
	const start = STAGE_IDS.indexOf(from);
	for (const id of STAGE_IDS.slice(start)) state.stages[id] = { status: "pending" };
}
