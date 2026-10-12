import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AbortedError, mapConcurrent, sleep } from "../../src/core/concurrency.ts";
import { appendJsonl, readJson, readJsonIfExists, readJsonl, writeJson } from "../../src/core/fs.ts";
import { TraceLogger } from "../../src/core/logger.ts";

describe("mapConcurrent", () => {
	it("preserves input order and respects the limit", async () => {
		let inFlight = 0;
		let peak = 0;
		const out = await mapConcurrent([30, 10, 20, 5], 2, async (ms, i) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await sleep(ms);
			inFlight--;
			return i * 10;
		});
		expect(out).toEqual([0, 10, 20, 30]);
		expect(peak).toBe(2);
	});

	it("reports results as they complete", async () => {
		const seen: number[] = [];
		await mapConcurrent([1, 2, 3], 3, async (x) => x * 2, { onResult: (r) => void seen.push(r) });
		expect(seen.sort()).toEqual([2, 4, 6]);
	});

	it("rethrows the first failure and stops scheduling", async () => {
		const started: number[] = [];
		await expect(
			mapConcurrent([1, 2, 3, 4, 5], 1, async (x) => {
				started.push(x);
				if (x === 2) throw new Error("boom");
				return x;
			}),
		).rejects.toThrow("boom");
		expect(started).toEqual([1, 2]);
	});

	it("aborts via signal", async () => {
		const controller = new AbortController();
		const run = mapConcurrent(
			[1, 2, 3],
			1,
			async (x) => {
				if (x === 1) controller.abort();
				return x;
			},
			{ signal: controller.signal },
		);
		await expect(run).rejects.toBeInstanceOf(AbortedError);
	});

	it("handles empty input", async () => {
		expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
	});
});

describe("sleep", () => {
	it("rejects when aborted", async () => {
		const controller = new AbortController();
		const p = sleep(10_000, controller.signal);
		controller.abort();
		await expect(p).rejects.toBeInstanceOf(AbortedError);
	});
});

describe("fs helpers", () => {
	it("round-trips JSON atomically and creates directories", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const path = join(dir, "nested", "a.json");
		await writeJson(path, { a: [1, 2] });
		expect(await readJson(path)).toEqual({ a: [1, 2] });
		expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
		expect(await readJsonIfExists(join(dir, "missing.json"))).toBeUndefined();
	});

	it("reads JSONL while skipping torn lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const path = join(dir, "x.jsonl");
		await appendJsonl(path, { n: 1 });
		await appendJsonl(path, { n: 2 });
		await writeFile(path, `${await readFile(path, "utf8")}{"n": 3`, "utf8");
		expect(await readJsonl(path)).toEqual([{ n: 1 }, { n: 2 }]);
		expect(await readJsonl(join(dir, "none.jsonl"))).toEqual([]);
	});
});

describe("TraceLogger", () => {
	it("writes trace blocks and notifies listeners", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const logger = new TraceLogger(join(dir, "logs", "trace.log"));
		const events: string[] = [];
		const off = logger.subscribe((e) => events.push(`${e.level}:${e.event}`));
		logger.info("STEP_ONE", "hello");
		logger.warn("STEP_TWO");
		off();
		logger.error("STEP_THREE");
		await logger.flush();
		const text = await readFile(join(dir, "logs", "trace.log"), "utf8");
		expect(text).toMatch(/\[\d\d:\d\d:\d\d\] === STEP_ONE ===\nhello\n=+/);
		expect(text).toContain("STEP_THREE");
		expect(events).toEqual(["info:STEP_ONE", "warn:STEP_TWO"]);
	});
});
