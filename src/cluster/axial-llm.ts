import type { ClusteredCodesFile, ReviewCodes } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { appendTo } from "../core/collections.ts";
import { asStringArray, cleanAndParseJson, isRecord, removeThinkTags } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import type { LlmClient } from "../llm/types.ts";
import { llmClusteringPrompt } from "../prompts/pipeline.ts";
import type { AxialResult } from "./axial-embedding.ts";
import { axialSummary } from "./axial-embedding.ts";

export type IterationClusters = Record<string, string[]>;

function pythonStrRepr(value: string): string {
	const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
	let body = "";
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (ch === "\\") body += "\\\\";
		else if (ch === quote) body += `\\${quote}`;
		else if (ch === "\n") body += "\\n";
		else if (ch === "\r") body += "\\r";
		else if (ch === "\t") body += "\\t";
		else if (code < 0x20 || code === 0x7f) body += `\\x${code.toString(16).padStart(2, "0")}`;
		else body += ch;
	}
	return `${quote}${body}${quote}`;
}

/** `str(list_of_strings)` as Python prints it; HICode sends the batch to the model in this form. */
export function pythonListRepr(items: readonly string[]): string {
	return `[${items.map(pythonStrRepr).join(", ")}]`;
}

/** Completion tokens that fit beside the batch in the server context window (inputs estimated at chars/3). */
export function completionBudget(
	systemPrompt: string,
	batch: readonly string[],
	llm: IdcoderConfig["clustering"]["llm"],
): number {
	const inputEstimate = Math.floor((systemPrompt.length + pythonListRepr(batch).length) / 3) + 128;
	return Math.min(llm.maxCompletion, Math.max(512, llm.contextLength - inputEstimate - 256));
}

/**
 * HICode's create_mapping: chains each original label (lowercased) through every iteration to its
 * final cluster key; labels whose cluster is not carried into the next iteration are abandoned.
 */
export function buildHicodeMapping(iterations: readonly IterationClusters[]): {
	finalKeyOf: Map<string, string>;
	display: Map<string, string>;
} {
	const display = new Map<string, string>();
	const reverses = iterations.map((cluster) => {
		const reverse = new Map<string, string>();
		for (const [key, members] of Object.entries(cluster)) {
			const keyLower = key.trim().toLowerCase();
			display.set(keyLower, key.trim());
			for (const member of members) reverse.set(member.trim().toLowerCase(), keyLower);
		}
		return reverse;
	});
	const finalKeyOf = new Map(reverses[0] ?? []);
	for (const reverse of reverses.slice(1)) {
		for (const [label, current] of [...finalKeyOf]) {
			const next = reverse.get(current);
			if (next === undefined) finalKeyOf.delete(label);
			else finalKeyOf.set(label, next);
		}
	}
	return { finalKeyOf, display };
}

/** Largest themes first (ties by name); overlong or empty theme names fall back to `Cluster N`. */
export function assignIntegerClusterIds(themeToCodes: Record<string, string[]>): {
	clusterToCodes: Record<string, string[]>;
	themeNames: Record<string, string>;
} {
	const sorted = Object.entries(themeToCodes).sort(
		(a, b) =>
			b[1].length - a[1].length ||
			(a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0),
	);
	const clusterToCodes: Record<string, string[]> = {};
	const themeNames: Record<string, string> = {};
	sorted.forEach(([theme, codes], i) => {
		const id = String(i);
		clusterToCodes[id] = [...codes];
		const label = theme.trim();
		themeNames[id] = label && label.length <= 120 ? label : `Cluster ${id}`;
	});
	return { clusterToCodes, themeNames };
}

async function runBatch(
	llm: LlmClient,
	system: string,
	batch: readonly string[],
	settings: IdcoderConfig["clustering"]["llm"],
	labels: { iteration: number; batch: number },
	signal?: AbortSignal,
): Promise<IterationClusters> {
	const response = await llm.complete({
		skill: "llm_clustering",
		system,
		prompt: pythonListRepr(batch),
		role: "clustering",
		maxTokens: completionBudget(system, batch, settings),
		labels: { phase: "llm_clustering", ...labels },
		signal,
	});
	try {
		const parsed = cleanAndParseJson(removeThinkTags(response.text));
		if (!isRecord(parsed)) return {};
		const out: IterationClusters = {};
		for (const [key, members] of Object.entries(parsed)) {
			if (Array.isArray(members)) out[String(key)] = asStringArray(members);
		}
		return out;
	} catch {
		return {};
	}
}

/** HICode-style multi-iteration LLM clustering (alternative to embedding + K-means). */
export async function clusterByLlm(
	allCodes: readonly string[],
	codesPerReview: readonly ReviewCodes[],
	deps: {
		llm: LlmClient;
		researchQuestion: string;
		settings: IdcoderConfig["clustering"]["llm"];
		logger: Logger;
		onIteration?: (iteration: number, clusters: IterationClusters) => Promise<void>;
		signal?: AbortSignal;
	},
): Promise<AxialResult> {
	const { llm, settings, logger, signal } = deps;
	const inputCodes = allCodes.map((c) => c.trim()).filter(Boolean);
	if (inputCodes.length === 0) throw new Error("No codes to cluster: open coding produced no codes.");

	const system = llmClusteringPrompt(deps.researchQuestion);
	let labelsToCluster = [...new Set(inputCodes)].sort();
	const iterations: IterationClusters[] = [];

	for (let iteration = 0; iteration < settings.maxIterations; iteration++) {
		const nBatch = Math.ceil(labelsToCluster.length / settings.batchSize);
		logger.info("LLM_CLUSTER_ITER", `iteration=${iteration} labels=${labelsToCluster.length} batches=${nBatch}`);
		const clusters: IterationClusters = {};
		for (let b = 0; b < nBatch; b++) {
			const batch = labelsToCluster.slice(b * settings.batchSize, (b + 1) * settings.batchSize);
			const output = await runBatch(llm, system, batch, settings, { iteration, batch: b }, signal);
			for (const [key, members] of Object.entries(output)) {
				appendTo(clusters, key, ...members);
			}
		}
		iterations.push(clusters);
		await deps.onIteration?.(iteration, clusters);
		labelsToCluster = Object.keys(clusters);
		if (nBatch <= 1) break;
	}

	const { finalKeyOf, display } = buildHicodeMapping(iterations);
	const originalOf = new Map<string, string>();
	for (const code of inputCodes) if (!originalOf.has(code.toLowerCase())) originalOf.set(code.toLowerCase(), code);

	const themeToCodes: Record<string, string[]> = {};
	const used = new Set<string>();
	for (const [labelLower, keyLower] of finalKeyOf) {
		const code = originalOf.get(labelLower);
		if (code === undefined || used.has(code)) continue;
		appendTo(themeToCodes, display.get(keyLower) ?? keyLower, code);
		used.add(code);
	}
	const unique = new Set(inputCodes).size;
	logger.info(
		"LLM_CLUSTER_DROPPED",
		`${unique - used.size}/${unique} unique labels abandoned (HICode drops labels not chained through all iterations).`,
	);
	if (Object.keys(themeToCodes).length === 0) throw new Error("LLM clustering produced no usable clusters.");

	const { clusterToCodes, themeNames } = assignIntegerClusterIds(themeToCodes);
	const ordered = Object.entries(clusterToCodes);
	const file: ClusteredCodesFile = {
		clustering_method: "llm",
		cluster_theme_names: themeNames,
		k: ordered.length,
		cluster_to_codes: clusterToCodes,
		all_codes: ordered.flatMap(([, codes]) => codes),
		labels: ordered.flatMap(([id, codes]) => codes.map(() => Number(id))),
		...(codesPerReview.length
			? { codes_per_review: codesPerReview.map(([id, codes]) => [id, [...codes]] as ReviewCodes) }
			: {}),
	};
	const named = Object.fromEntries(ordered.map(([id, codes]) => [`${id} (${themeNames[id]})`, codes]));
	return {
		file,
		summary: axialSummary(
			`Axial coding (LLM clustering): ${ordered.length} clusters, ${iterations.length} iteration(s).`,
			named,
			20,
		),
	};
}
