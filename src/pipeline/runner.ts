import { rm } from "node:fs/promises";
import type { RunPaths } from "../artifacts/paths.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { AbortedError } from "../core/concurrency.ts";
import { deleteSnapshot, hasSnapshot, restoreSnapshot, takeSnapshot } from "./snapshots.ts";
import { STAGE_IDS, type Stage, type StageContext, type StageId, type StageProgress } from "./stage.ts";
import { type RunState, resetFrom, saveState } from "./state.ts";

export type RunEvent =
	| { type: "stage_start"; stage: StageId; title: string; index: number; total: number }
	| { type: "stage_progress"; stage: StageId; progress: StageProgress }
	| { type: "stage_end"; stage: StageId; status: "done" | "skipped" | "paused"; summary: string }
	| { type: "stage_error"; stage: StageId; error: string };

export type RunResult =
	| { status: "completed"; state: RunState }
	| { status: "paused"; stage: StageId; message: string; state: RunState }
	| { status: "failed"; stage: StageId; error: Error; state: RunState }
	| { status: "aborted"; stage: StageId; state: RunState };

export interface RunOptions {
	/** Re-run this stage and everything after it. */
	from?: StageId | undefined;
	/** Stop after this stage completes. */
	until?: StageId | undefined;
	onEvent?: ((event: RunEvent) => void) | undefined;
	signal?: AbortSignal | undefined;
	/** Lets the runner notice stages that were skipped earlier but are enabled now. */
	config?: IdcoderConfig | undefined;
}

export class RunOptionsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunOptionsError";
	}
}

export class PipelineRunner {
	private readonly stages: readonly Stage[];

	constructor(stages: readonly Stage[]) {
		const order = stages.map((s) => s.id);
		const expected = STAGE_IDS.filter((id) => order.includes(id));
		if (order.join() !== expected.join())
			throw new Error(`Stages must follow pipeline order: ${expected.join(", ")}`);
		this.stages = stages;
	}

	/**
	 * Runs pending stages in order, persisting state after every transition so an interrupted or
	 * paused run resumes exactly where it stopped.
	 */
	async run(
		state: RunState,
		paths: RunPaths,
		makeContext: (stage: Stage, progress: (p: StageProgress) => void) => StageContext,
		options: RunOptions = {},
	): Promise<RunResult> {
		const statePath = paths.state;
		const position = (id: StageId) => STAGE_IDS.indexOf(id);
		if (options.from && options.until && position(options.from) > position(options.until)) {
			throw new RunOptionsError(
				`\`from\` (${options.from}) comes after \`until\` (${options.until}); nothing would run.`,
			);
		}
		const reenabled = options.config
			? this.stages.find((s) => state.stages[s.id].status === "skipped" && s.enabled(options.config!))?.id
			: undefined;
		const restart = [options.from, reenabled]
			.filter((id): id is StageId => id !== undefined)
			.sort((a, b) => position(a) - position(b))[0];
		if (restart) await this.reset(state, paths, restart);

		const emit = options.onEvent ?? (() => {});
		const untilIndex = options.until ? position(options.until) : Number.POSITIVE_INFINITY;

		for (const [index, stage] of this.stages.entries()) {
			if (position(stage.id) > untilIndex) break;
			const record = state.stages[stage.id];
			if (record.status === "done" || record.status === "skipped") continue;
			if (options.signal?.aborted) {
				await saveState(statePath, state);
				return { status: "aborted", stage: stage.id, state };
			}

			const ctx = makeContext(stage, (progress) => emit({ type: "stage_progress", stage: stage.id, progress }));
			if (!stage.enabled(ctx.config)) {
				state.stages[stage.id] = { status: "skipped", summary: "disabled by config" };
				await saveState(statePath, state);
				emit({ type: "stage_end", stage: stage.id, status: "skipped", summary: "disabled by config" });
				continue;
			}

			if (await hasSnapshot(paths, stage.id)) await restoreSnapshot(paths, stage.id);
			else await takeSnapshot(paths, stage.id);

			const startedAt = new Date().toISOString();
			state.stages[stage.id] = { status: "running", startedAt };
			await saveState(statePath, state);
			emit({ type: "stage_start", stage: stage.id, title: stage.title, index, total: this.stages.length });
			ctx.logger.info(`STAGE_START`, stage.id);

			try {
				const outcome = await stage.run(ctx);
				const finishedAt = new Date().toISOString();
				if (outcome.status === "paused") {
					state.stages[stage.id] = { status: "paused", startedAt, summary: outcome.summary };
					await saveState(statePath, state);
					emit({ type: "stage_end", stage: stage.id, status: "paused", summary: outcome.summary });
					return { status: "paused", stage: stage.id, message: outcome.summary, state };
				}
				state.stages[stage.id] = {
					status: outcome.status,
					startedAt,
					finishedAt,
					summary: outcome.summary,
					...(outcome.status === "done" && outcome.metrics ? { metrics: outcome.metrics } : {}),
				};
				await saveState(statePath, state);
				ctx.logger.info(`STAGE_${outcome.status.toUpperCase()}`, `${stage.id}: ${outcome.summary}`);
				emit({ type: "stage_end", stage: stage.id, status: outcome.status, summary: outcome.summary });
			} catch (caught) {
				if (caught instanceof AbortedError || ctx.signal?.aborted) {
					state.stages[stage.id] = { status: "pending", summary: "aborted; resumes from checkpoints" };
					await saveState(statePath, state);
					return { status: "aborted", stage: stage.id, state };
				}
				const error = caught instanceof Error ? caught : new Error(String(caught));
				state.stages[stage.id] = {
					status: "failed",
					startedAt,
					finishedAt: new Date().toISOString(),
					error: error.message,
				};
				await saveState(statePath, state);
				ctx.logger.error("STAGE_FAILED", `${stage.id}: ${error.stack ?? error.message}`);
				emit({ type: "stage_error", stage: stage.id, error: error.message });
				return { status: "failed", stage: stage.id, error, state };
			}
		}
		return { status: "completed", state };
	}

	/**
	 * Resets `from` and everything after it: checkpoints are deleted, and the in-place artifacts are
	 * restored from the earliest snapshot at or after `from` (skipped stages take none), so the
	 * stage sees exactly the inputs it would see on a fresh run.
	 */
	private async reset(state: RunState, paths: RunPaths, from: StageId): Promise<void> {
		resetFrom(state, from);
		const affected = this.stages.filter((s) => STAGE_IDS.indexOf(s.id) >= STAGE_IDS.indexOf(from));
		for (const stage of affected) {
			for (const file of stage.checkpoints?.(paths) ?? []) await rm(file, { force: true });
		}
		for (const stage of affected) {
			if (await restoreSnapshot(paths, stage.id)) break;
		}
		for (const stage of affected) await deleteSnapshot(paths, stage.id);
		await saveState(paths.state, state);
	}
}
