import { appendTo } from "../../src/core/collections.ts";
import type { GatewayRequest, GatewayResponse, ModelGateway } from "../../src/llm/gateway.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "../../src/llm/types.ts";
import { ONE_CALL_USAGE } from "./fake-llm.ts";

/**
 * A deterministic stand-in for a real model that understands every pipeline prompt well enough to
 * produce valid, plausible output. It lets the whole pipeline run offline end to end.
 */

export const THEMES: Record<string, string[]> = {
	crash: ["frequent crash on load", "crash after update", "random crash mid game"],
	lag: ["laggy online matchmaking", "lag spikes online", "constant lag online"],
	price: ["price of skins too high", "dlc price unfair", "steep price tiers"],
	story: ["weak story pacing", "story ending rushed", "flat story characters"],
};

const STOP = new Set(["of", "on", "the", "a", "too", "mid", "after", "online", "high", "unfair", "steep"]);

function hash(text: string): number {
	let h = 0;
	for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
	return h;
}

function between(prompt: string, start: string, end?: string): string {
	const i = prompt.indexOf(start);
	if (i === -1) return "";
	const rest = prompt.slice(i + start.length);
	if (!end) return rest;
	const j = rest.indexOf(end);
	return j === -1 ? rest : rest.slice(0, j);
}

function bullets(block: string): string[] {
	return block
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("- "))
		.map((l) => l.slice(2).trim());
}

function idsAfter(prompt: string, marker: string): string[] {
	const line = between(prompt, marker, "\n");
	return line
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function dominantWord(codes: readonly string[]): { word: string; share: number } {
	const counts = new Map<string, number>();
	for (const code of codes) {
		for (const word of new Set(code.toLowerCase().split(/\s+/))) {
			if (!STOP.has(word) && word.length > 2) counts.set(word, (counts.get(word) ?? 0) + 1);
		}
	}
	const [word, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [
		"misc",
		0,
	];
	return { word, share: codes.length ? count / codes.length : 0 };
}

function openCoding(prompt: string): string {
	const review = between(prompt, "\nReview:\n").trim();
	const sentences = review.split(/(?<=[.!?])\s+/).filter(Boolean);
	const blocks: string[] = [];
	for (const [theme, templates] of Object.entries(THEMES)) {
		const sentence = sentences.find((s) => s.toLowerCase().includes(theme));
		if (!sentence || blocks.length >= 3) continue;
		const code = templates[hash(review + theme) % templates.length]!;
		blocks.push(`- Code: ${code}\n  Evidence: "${sentence}"\n  Note: mentions ${theme}`);
	}
	if (blocks.length === 0) {
		return `- Applicability: NONE\n  Reason: The review does not address the question.\n  Evidence: "${sentences[0] ?? review}"`;
	}
	return blocks.join("\n\n");
}

function label(prompt: string): string {
	const codes = bullets(between(prompt, "belong to one cluster:", "Output a single JSON")).filter(
		(c) => !c.startsWith("..."),
	);
	const { word, share } = dominantWord(codes);
	return JSON.stringify({
		label: `${word[0]!.toUpperCase()}${word.slice(1)} problems`,
		confidence: share >= 0.6 ? 4 : 2,
		rationale: `Most codes mention ${word}.`,
	});
}

function synthesis(prompt: string): string {
	const candidates = bullets(between(prompt, "Candidate labels:", "Produce a single"));
	const counts = new Map<string, number>();
	for (const c of candidates) counts.set(c, (counts.get(c) ?? 0) + 1);
	const [best, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["Misc problems", 0];
	return JSON.stringify({ label: best, confidence: n === candidates.length ? 5 : 3, rationale: "Candidates agree." });
}

function enrichment(prompt: string, batch: boolean): string {
	const ids = idsAfter(prompt, batch ? "use ONLY these: " : "do not invent others: ");
	const theme = between(prompt, "Theme: ", "\n");
	const criteria = (offset: number) => [
		{ criterion: `Explicit mention of ${theme.toLowerCase()} (${offset}a).`, code_ids: [ids[0]!] },
		{ criterion: `Specific complaint about ${theme.toLowerCase()} (${offset}b).`, code_ids: [ids[ids.length - 1]!] },
	];
	if (batch) {
		return JSON.stringify({ definition_notes: `Notes on ${theme}`, inclusion: criteria(1), exclusion: criteria(2) });
	}
	return JSON.stringify({
		label: theme,
		definition: `Captures player statements about ${theme.toLowerCase()}.`,
		keywords: theme.toLowerCase().split(" "),
		inclusion: criteria(1),
		exclusion: criteria(2),
	});
}

function hierarchy(prompt: string): string {
	if (prompt.includes("Existing sub-themes:")) {
		const names = bullets(between(prompt, "Existing sub-themes:", "Assign each"));
		const codes = bullets(between(prompt, "Codes:", "Output ONLY"));
		return JSON.stringify({ assignments: { [names[0]!]: codes }, unassigned: [] });
	}
	const codes = bullets(between(prompt, "It contains these codes (one per line):", "Your task:"));
	const half = Math.ceil(codes.length / 2);
	return JSON.stringify({
		sub_themes: [
			{ name: "First facet", codes: codes.slice(0, half) },
			{ name: "Second facet", codes: codes.slice(half) },
		],
		ungrouped_codes: [],
	});
}

function metaThemes(prompt: string): string {
	const json = between(prompt, "mapping cluster IDs to their labels:\n\n", "\n\nYour task");
	const ids = Object.keys(JSON.parse(`${between(json, "", "\n}")}\n}`) as Record<string, string>).sort(
		(a, b) => Number(a) - Number(b),
	);
	const groups = Math.min(3, ids.length);
	const out = Array.from({ length: groups }, (_, g) => ({
		name: `Meta theme ${g + 1}`,
		cluster_ids: ids.filter((_, i) => i % groups === g),
	}));
	return JSON.stringify({ meta_themes: out });
}

function dimension(prompt: string): string {
	const own = idsAfter(prompt, "This dimension's Cluster IDs (use for inclusion): ");
	const all = idsAfter(prompt, "All available Cluster IDs (may use for exclusion boundary criteria): ");
	const other = all.find((id) => !own.includes(id)) ?? own[0]!;
	const name = between(prompt, "Dimension: ", "\n");
	return JSON.stringify({
		label: name,
		definition: `Broad territory of ${name}.`,
		keywords: ["players", "experience"],
		inclusion: own.map((id) => ({ criterion: `Statements grounded in ${id}.`, code_ids: [id] })).slice(0, 3),
		exclusion: [
			{ criterion: `Not content belonging to ${other}.`, code_ids: [other] },
			{ criterion: "Not generic praise.", code_ids: [own[0]!] },
		],
	});
}

function hierarchyRefine(prompt: string): string {
	const n = Number(/exactly (\d+) non-empty/.exec(prompt)?.[1] ?? 2);
	const codes = bullets(between(prompt, "Codes (use EXACT strings; do not rename or drop any):", "Rules:"));
	const groups = Array.from({ length: n }, (_, g) => ({
		name: `Group ${g + 1}`,
		codes: codes.filter((_, i) => i % n === g),
	}));
	return JSON.stringify({ sub_themes: groups.filter((g) => g.codes.length) });
}

function llmClustering(prompt: string): string {
	const labels = [...prompt.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2] ?? "");
	const groups: Record<string, string[]> = {};
	for (const labelText of labels) {
		const theme = Object.keys(THEMES).find((t) => labelText.toLowerCase().includes(t)) ?? labelText;
		const key = `${theme[0]!.toUpperCase()}${theme.slice(1)} issues`;
		appendTo(groups, key, labelText);
	}
	return JSON.stringify(groups);
}

function recode(prompt: string): string {
	const letters = [...prompt.matchAll(/^\[([A-Z])\] LABEL:/gm)].map((m) => m[1]!);
	const quotes = [...between(prompt, "QUOTES TO CLASSIFY:", "---\nFor EACH quote").matchAll(/^(\d+)\. "(.*)"$/gm)];
	const choices = [...letters, "NONE"];
	return JSON.stringify({
		classifications: quotes.map((m) => ({
			quote_index: Number(m[1]),
			meta_theme: choices[hash(m[2]!) % choices.length],
		})),
	});
}

function judge(prompt: string): string {
	const fourWay = prompt.includes('"A", "B", "BOTH", or "NEITHER"');
	const picks = fourWay ? ["A", "B", "BOTH", "NEITHER"] : ["A", "B"];
	const quotes = [...prompt.matchAll(/^(\d+)\. QUOTE: "(.*)"$/gm)];
	return JSON.stringify({
		verdicts: quotes.map((m) => ({ item_index: Number(m[1]), pick: picks[hash(m[2]!) % picks.length] })),
	});
}

export function simulate(request: Pick<LlmRequest, "skill" | "prompt">): string {
	const p = request.prompt;
	switch (request.skill) {
		case "open_coding":
			return openCoding(p);
		case "validate_open_codes":
			return "PASS";
		case "high_level_code_generation":
			return label(p);
		case "high_level_synthesis":
			return synthesis(p);
		case "refine_cluster_assignments":
			return "NONE";
		case "codebook_enrichment":
			return enrichment(p, false);
		case "codebook_batch_enrich":
			return enrichment(p, true);
		case "hierarchy_construction":
			return hierarchy(p);
		case "meta_theme_grouping":
			return metaThemes(p);
		case "dimension_enrichment":
			return dimension(p);
		case "hierarchy_refine":
			return hierarchyRefine(p);
		case "llm_clustering":
			return llmClustering(p);
		case "deductive_recode":
			return recode(p);
		case "disagreement_judge":
			return judge(p);
		case "research_report":
			return "## Research question\nWhat frustrates players?\n\n## Graph structure\nSimulated.\n\n## Research answer\nPlayers are frustrated by crashes, lag, prices, and story.";
		default:
			throw new Error(`SimulatedLlm has no behaviour for skill "${request.skill}"`);
	}
}

export class SimulatedLlm implements LlmClient {
	readonly calls: LlmRequest[] = [];
	private readonly overrides: Partial<Record<string, (request: LlmRequest) => string>>;

	constructor(overrides: Partial<Record<string, (request: LlmRequest) => string>> = {}) {
		this.overrides = overrides;
	}

	count(skill: string): number {
		return this.calls.filter((c) => c.skill === skill).length;
	}

	async complete(request: LlmRequest): Promise<LlmResponse> {
		this.calls.push(request);
		if (request.signal?.aborted) throw new Error("aborted");
		const text = (this.overrides[request.skill] ?? simulate)(request);
		return { text, model: request.model ?? "sim/model", usage: ONE_CALL_USAGE, latencyMs: 0 };
	}
}

/** Thirty-two short game reviews spanning the four simulated themes plus a few off-topic ones. */
export function gameReviews(): string[] {
	const crash = [
		"The game crash happens on every load.",
		"Another crash after the patch.",
		"Random crash during boss fights.",
	];
	const lag = ["Online play has terrible lag.", "Lag makes ranked unplayable.", "Constant lag in matchmaking."];
	const price = ["The price of skins is absurd.", "DLC price is a ripoff.", "Price tiers feel predatory."];
	const story = ["The story drags in act two.", "Story ending felt rushed.", "Story characters are flat."];
	const reviews: string[] = [];
	for (let i = 0; i < 7; i++) {
		reviews.push(crash[i % 3]!, lag[i % 3]!, price[i % 3]!, story[i % 3]!);
	}
	reviews.push(
		"I love this game.",
		"Pretty fine overall.",
		"The story is great but the crash on startup ruins it.",
		"Five stars.",
	);
	return reviews.map((r, i) => `${r} (#${i + 1})`);
}

const SKILL_MARKERS: Array<[string, string]> = [
	["You are doing Open Coding", "open_coding"],
	["You are reviewing qualitative codes generated", "validate_open_codes"],
	["belong to one cluster:", "high_level_code_generation"],
	["You are synthesizing multiple candidate labels", "high_level_synthesis"],
	["You are reviewing the codes assigned to a cluster labeled", "refine_cluster_assignments"],
	["VALID Code IDs for this batch", "codebook_batch_enrich"],
	["VALID Code IDs — use ONLY these", "codebook_enrichment"],
	["You are building a thematic hierarchy", "hierarchy_construction"],
	["Existing sub-themes:", "hierarchy_construction"],
	["You are organising the results of a thematic analysis", "meta_theme_grouping"],
	["This dimension's Cluster IDs", "dimension_enrichment"],
	["You are refining a thematic hierarchy", "hierarchy_refine"],
	["You are a qualitative researcher. Your job is to **answer", "research_report"],
];

/** Recovers the pipeline skill from prompt text, as a real model would only ever see text. */
export function inferSkill(system: string, prompt: string): string {
	if (system.startsWith("Synthesize the entire list of labels")) return "llm_clustering";
	if (system.startsWith("You are a qualitative coding expert applying")) return "deductive_recode";
	if (system.startsWith("You are a qualitative research expert judging")) return "disagreement_judge";
	const found = SKILL_MARKERS.find(([marker]) => prompt.includes(marker));
	if (!found) throw new Error(`SimulatedGateway cannot infer the skill for prompt: ${prompt.slice(0, 120)}`);
	return found[1];
}

/** A ModelGateway backed by the simulator, so tests exercise LlmService (skills, retries, usage) too. */
export class SimulatedGateway implements ModelGateway {
	readonly calls: Array<{ ref: string; skill: string; request: GatewayRequest }> = [];
	private readonly extra: (ref: string, skill: string, request: GatewayRequest) => string | undefined;

	constructor(extra: (ref: string, skill: string, request: GatewayRequest) => string | undefined = () => undefined) {
		this.extra = extra;
	}

	describe(ref: string): string {
		return ref === "current" ? "sim/current" : ref;
	}

	async complete(ref: string, request: GatewayRequest): Promise<GatewayResponse> {
		const fromExtra = this.extra(ref, "", request);
		const skill = fromExtra === undefined ? inferSkill(request.system, request.prompt) : "custom";
		this.calls.push({ ref, skill, request });
		const text = fromExtra ?? simulate({ skill, prompt: request.prompt });
		return { text, stopReason: "stop", usage: ONE_CALL_USAGE, model: this.describe(ref) };
	}
}
