import type { EnrichedEntry, GroundedExample } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { localCodeId } from "../core/ids.ts";
import { asRecordArray, asString, asStringArray, parseJsonObject } from "../core/json.ts";
import type { Logger } from "../core/logger.ts";
import { type SourceMemory, toGroundedExample } from "../evidence/source-memory.ts";
import type { LlmClient } from "../llm/types.ts";
import {
	codebookBatchEnrichmentPrompt,
	codebookEnrichmentPrompt,
	codebookSynthesisPrompt,
	invalidIdsCorrection,
} from "../prompts/pipeline.ts";
import { batchEntrySchema, emptyEntry, entrySchema, filterCodeIds, parseEntry } from "./criteria.ts";

export interface EvidenceIndex {
	quotes: ReadonlyMap<string, readonly string[]>;
	notes: ReadonlyMap<string, readonly string[]>;
}

/** Code list with cluster-local ids, up to two quotes and one note per code. */
export function codesWithEvidence(
	codes: readonly string[],
	evidence: EvidenceIndex,
	idOf: (code: string, index: number) => string,
): string {
	const lines: string[] = [];
	codes.forEach((code, i) => {
		lines.push(`- [${idOf(code, i)}] ${code}`);
		for (const quote of (evidence.quotes.get(code) ?? []).slice(0, 2)) lines.push(`  [QUOTE] "${quote}"`);
		for (const note of (evidence.notes.get(code) ?? []).slice(0, 1)) lines.push(`  [NOTE] ${note}`);
	});
	return lines.join("\n");
}

interface PartialEntry {
	definition_notes: string;
	inclusion: Array<{ criterion: string; code_ids: string[] }>;
	exclusion: Array<{ criterion: string; code_ids: string[] }>;
}

function parsePartial(text: string): PartialEntry {
	try {
		const parsed = parseJsonObject(text);
		const criteria = (value: unknown) =>
			asRecordArray(value).map((c) => ({ criterion: asString(c.criterion), code_ids: asStringArray(c.code_ids) }));
		return {
			definition_notes: asString(parsed.definition_notes),
			inclusion: criteria(parsed.inclusion),
			exclusion: criteria(parsed.exclusion),
		};
	} catch {
		return { definition_notes: "", inclusion: [], exclusion: [] };
	}
}

export function renderPartials(partials: readonly PartialEntry[]): string {
	let block = "";
	partials.forEach((entry, i) => {
		block += `\n[Batch ${i + 1}/${partials.length}]\n`;
		block += `Definition notes: ${entry.definition_notes}\n`;
		if (entry.inclusion.length) {
			block += "Inclusion criteria:\n";
			for (const c of entry.inclusion) block += `  - ${c.criterion} (codes: ${c.code_ids.join(", ")})\n`;
		}
		if (entry.exclusion.length) {
			block += "Exclusion criteria:\n";
			for (const c of entry.exclusion) block += `  - ${c.criterion} (codes: ${c.code_ids.join(", ")})\n`;
		}
	});
	return block;
}

/**
 * Fills each criterion's examples from real snippets of its cited codes (never from model text),
 * up to three per criterion, then drops criteria that ended up without evidence.
 */
export function fillExamplesFromMemory(
	entry: EnrichedEntry,
	codeOfLocalId: ReadonlyMap<string, string>,
	memory: SourceMemory,
): void {
	for (const section of ["inclusion", "exclusion"] as const) {
		for (const item of entry[section]) {
			const used = new Set<string>();
			const examples: GroundedExample[] = [];
			for (const id of item.code_ids) {
				const snippet = memory.pickSnippetForCode(codeOfLocalId.get(id) ?? "", used);
				if (snippet) {
					used.add(snippet.snippet_id);
					examples.push(toGroundedExample(snippet));
				}
				if (examples.length === 3) break;
			}
			item.examples = examples;
		}
		entry[section] = entry[section].filter((item) => item.examples && item.examples.length > 0);
	}
}

export interface EnrichDeps {
	llm: LlmClient;
	memory: SourceMemory;
	evidence: EvidenceIndex;
	settings: IdcoderConfig["enrichment"];
	logger: Logger;
	signal?: AbortSignal | undefined;
}

/** Definition, keywords, inclusion and exclusion criteria for one cluster (paper §3.1, Codebook Construction). */
export async function enrichCluster(
	clusterId: string,
	label: string,
	codes: readonly string[],
	deps: EnrichDeps,
): Promise<EnrichedEntry> {
	const { llm, evidence, settings, logger, signal } = deps;
	const codeOfLocalId = new Map(codes.map((code, i) => [localCodeId(i), code]));
	const localIdOf = new Map(codes.map((code, i) => [code, localCodeId(i)]));
	const validIds = [...codeOfLocalId.keys()];
	const validSet = new Set(validIds);
	const validText = [...validIds].sort().join(", ");
	const schema = entrySchema("codebook_entry", validIds);
	const withEvidence = codes.filter((c) => (evidence.quotes.get(c) ?? []).length > 0).length;

	try {
		let prompt: string;
		if (codes.length <= settings.batchThreshold) {
			logger.info(
				"ENRICH_COVERAGE",
				`Cluster ${clusterId} (${label}): ${codes.length} codes total — all seen directly. Evidence available: ${withEvidence}/${codes.length} codes.`,
			);
			prompt = codebookEnrichmentPrompt(
				label,
				validText,
				codesWithEvidence(codes, evidence, (_c, i) => localCodeId(i)),
			);
		} else {
			const batches: string[][] = [];
			for (let i = 0; i < codes.length; i += settings.batchSize)
				batches.push(codes.slice(i, i + settings.batchSize));
			const partials = await mapConcurrent(
				batches,
				Math.min(batches.length, 4),
				async (batch) => {
					const ids = batch.map((c) => localIdOf.get(c)!).sort();
					const response = await llm.complete({
						skill: "codebook_batch_enrich",
						prompt: codebookBatchEnrichmentPrompt(
							label,
							ids.join(", "),
							codesWithEvidence(batch, evidence, (c) => localIdOf.get(c)!),
						),
						role: "enrichment",
						jsonSchema: batchEntrySchema(ids),
						labels: { cluster_id: clusterId },
						signal,
					});
					return parsePartial(response.text);
				},
				{ signal },
			);
			logger.info(
				"ENRICH_COVERAGE",
				`Cluster ${clusterId} (${label}): ${codes.length} codes total — batch path across ${batches.length} batches. Evidence available: ${withEvidence}/${codes.length} codes.`,
			);
			const allLabels = codes.map((c, i) => `- [${localCodeId(i)}] ${c}`).join("\n");
			prompt = codebookSynthesisPrompt(
				label,
				validText,
				codes.length,
				allLabels,
				settings.batchSize,
				renderPartials(partials),
			);
		}

		const ask = async (text: string) =>
			(
				await llm.complete({
					skill: "codebook_enrichment",
					prompt: text,
					role: "enrichment",
					jsonSchema: schema,
					labels: { cluster_id: clusterId },
					signal,
				})
			).text;

		let entry = parseEntry(await ask(prompt), label);
		let { bad } = filterCodeIds(entry, validSet);
		if (bad.size) {
			logger.warn("ENRICH_RETRY", `Cluster '${label}': invalid IDs ${[...bad].join(", ")} — retrying`);
			entry = parseEntry(await ask(prompt + invalidIdsCorrection([...bad], validText)), label);
			({ bad } = filterCodeIds(entry, validSet));
			if (bad.size)
				logger.warn(
					"ENRICH_WARN",
					`Cluster '${label}': still invalid IDs after retry ${[...bad].join(", ")} — dropped`,
				);
		}
		fillExamplesFromMemory(entry, codeOfLocalId, deps.memory);
		return entry;
	} catch (error) {
		if (signal?.aborted) throw error;
		logger.warn("ENRICH_WARN", `Cluster ${clusterId} (${label}): ${(error as Error).message}`);
		return emptyEntry(label);
	}
}
