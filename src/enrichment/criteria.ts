import type { Criterion, EnrichedEntry } from "../artifacts/types.ts";
import { asRecordArray, asString, asStringArray, type JsonObject, parseJsonObject } from "../core/json.ts";
import type { JsonSchemaHint } from "../llm/types.ts";

export const REQUIRED_ENTRY_KEYS = ["label", "definition", "keywords", "inclusion", "exclusion"] as const;

function criterionSchema(ids: readonly string[]): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			criterion: { type: "string" },
			code_ids: {
				type: "array",
				items: ids.length ? { type: "string", enum: [...ids].sort() } : { type: "string" },
			},
		},
		required: ["criterion", "code_ids"],
		additionalProperties: false,
	};
}

/** Structured-output schema with code ids constrained to the ids the model may cite. */
export function entrySchema(
	name: string,
	inclusionIds: readonly string[],
	exclusionIds = inclusionIds,
): JsonSchemaHint {
	return {
		name,
		schema: {
			type: "object",
			properties: {
				label: { type: "string" },
				definition: { type: "string" },
				keywords: { type: "array", items: { type: "string" } },
				inclusion: { type: "array", items: criterionSchema(inclusionIds) },
				exclusion: { type: "array", items: criterionSchema(exclusionIds) },
			},
			required: [...REQUIRED_ENTRY_KEYS],
			additionalProperties: false,
		},
	};
}

export function batchEntrySchema(ids: readonly string[]): JsonSchemaHint {
	return {
		name: "batch_codebook_entry",
		schema: {
			type: "object",
			properties: {
				definition_notes: { type: "string" },
				inclusion: { type: "array", items: criterionSchema(ids) },
				exclusion: { type: "array", items: criterionSchema(ids) },
			},
			required: ["definition_notes", "inclusion", "exclusion"],
			additionalProperties: false,
		},
	};
}

function parseCriteria(value: unknown): Criterion[] {
	return asRecordArray(value).map((item: JsonObject) => ({
		criterion: asString(item.criterion),
		code_ids: asStringArray(item.code_ids),
	}));
}

/** Parses an entry and requires every key; throws so the caller can retry or record a failure. */
export function parseEntry(text: string, label: string): EnrichedEntry {
	const parsed = parseJsonObject(text);
	const missing = REQUIRED_ENTRY_KEYS.filter((k) => !(k in parsed));
	if (missing.length) throw new Error(`missing keys: ${missing.join(", ")}`);
	return {
		label,
		definition: asString(parsed.definition),
		keywords: asStringArray(parsed.keywords),
		inclusion: parseCriteria(parsed.inclusion),
		exclusion: parseCriteria(parsed.exclusion),
	};
}

/**
 * Removes code ids outside the allowed sets and drops criteria left without any; returns the
 * invalid ids so the caller can ask the model to correct itself.
 */
export function filterCodeIds(
	entry: EnrichedEntry,
	inclusionAllowed: ReadonlySet<string>,
	exclusionAllowed: ReadonlySet<string> = inclusionAllowed,
): { bad: Set<string>; dropped: number } {
	const bad = new Set<string>();
	let dropped = 0;
	for (const [section, allowed] of [
		["inclusion", inclusionAllowed],
		["exclusion", exclusionAllowed],
	] as const) {
		for (const item of entry[section]) {
			for (const id of item.code_ids) if (!allowed.has(id)) bad.add(id);
			item.code_ids = item.code_ids.filter((id) => allowed.has(id));
		}
		const before = entry[section].length;
		entry[section] = entry[section].filter((item) => item.code_ids.length > 0);
		dropped += before - entry[section].length;
	}
	return { bad, dropped };
}

export function emptyEntry(label: string): EnrichedEntry {
	return { label, definition: "", keywords: [], inclusion: [], exclusion: [] };
}

export function entryFailed(entry: EnrichedEntry): boolean {
	return entry.inclusion.length === 0 && !entry.definition;
}
