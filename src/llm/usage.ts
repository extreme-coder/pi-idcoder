import { appendJsonl, readJsonl } from "../core/fs.ts";
import { addUsage, type TokenUsage, ZERO_USAGE } from "./types.ts";

export interface UsageRecord {
	ts: string;
	stage: string | null;
	skill: string;
	model: string;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cost: number;
	latency_ms: number;
	labels: Record<string, unknown>;
}

/** Appends one JSON line per LLM call and keeps running totals for tool results. */
export class UsageRecorder {
	private totals: TokenUsage = { ...ZERO_USAGE };
	private calls = 0;
	private queue: Promise<void> = Promise.resolve();
	private readonly path: string | undefined;

	constructor(path: string | undefined) {
		this.path = path;
	}

	record(entry: {
		stage: string | null;
		skill: string;
		model: string;
		usage: TokenUsage;
		latencyMs: number;
		labels?: Record<string, unknown>;
	}): void {
		this.totals = addUsage(this.totals, entry.usage);
		this.calls++;
		const path = this.path;
		if (!path) return;
		const record: UsageRecord = {
			ts: new Date().toISOString(),
			stage: entry.stage,
			skill: entry.skill,
			model: entry.model,
			prompt_tokens: entry.usage.input,
			completion_tokens: entry.usage.output,
			total_tokens: entry.usage.total,
			cost: entry.usage.cost,
			latency_ms: Math.round(entry.latencyMs * 100) / 100,
			labels: entry.labels ?? {},
		};
		this.queue = this.queue.then(() => appendJsonl(path, record)).catch(() => {});
	}

	snapshot(): { calls: number; usage: TokenUsage } {
		return { calls: this.calls, usage: { ...this.totals } };
	}

	flush(): Promise<void> {
		return this.queue;
	}
}

interface Bucket {
	calls: number;
	prompt: number;
	completion: number;
	total: number;
	cost: number;
}

function addTo(map: Map<string, Bucket>, key: string, r: UsageRecord): void {
	const b = map.get(key) ?? { calls: 0, prompt: 0, completion: 0, total: 0, cost: 0 };
	b.calls++;
	b.prompt += r.prompt_tokens || 0;
	b.completion += r.completion_tokens || 0;
	b.total += r.total_tokens || (r.prompt_tokens || 0) + (r.completion_tokens || 0);
	b.cost += r.cost || 0;
	map.set(key, b);
}

function line(key: string, b: Bucket): string {
	return `  ${key}: calls=${b.calls} in=${b.prompt} out=${b.completion} total=${b.total} cost=$${b.cost.toFixed(4)}`;
}

export async function summarizeUsage(path: string): Promise<string> {
	const records = await readJsonl<UsageRecord>(path);
	if (records.length === 0) return "No LLM usage recorded.";
	const grand = new Map<string, Bucket>();
	const byStage = new Map<string, Bucket>();
	const bySkill = new Map<string, Bucket>();
	const byModel = new Map<string, Bucket>();
	for (const r of records) {
		addTo(grand, "all", r);
		addTo(byStage, String(r.stage), r);
		addTo(bySkill, r.skill, r);
		addTo(byModel, r.model, r);
	}
	const g = grand.get("all")!;
	const section = (title: string, map: Map<string, Bucket>) => [
		"",
		`${title}:`,
		...[...map.keys()].sort().map((k) => line(k, map.get(k)!)),
	];
	return [
		`Total LLM calls: ${g.calls}`,
		`  prompt_tokens=${g.prompt} completion_tokens=${g.completion} total_tokens=${g.total} cost=$${g.cost.toFixed(4)}`,
		...section("By stage", byStage),
		...section("By skill", bySkill),
		...section("By model", byModel),
	].join("\n");
}
