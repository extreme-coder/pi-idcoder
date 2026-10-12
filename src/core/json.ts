export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function asRecordArray(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** Coerces model output like `4`, `"4"`, or `4.6` into an integer clamped to [min, max]. */
export function asClampedInt(value: unknown, min: number, max: number, fallback: number): number {
	let n: number;
	if (typeof value === "number") n = value;
	else if (typeof value === "string" && value.trim() !== "") n = Number(value);
	else return fallback;
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function removeThinkTags(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Parses the outermost `{...}` span of a model response, after removing reasoning blocks. */
export function cleanAndParseJson(text: string): unknown {
	const cleaned = removeThinkTags(text);
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end === -1 || end < start) {
		throw new Error("No JSON brackets found.");
	}
	return JSON.parse(cleaned.slice(start, end + 1));
}

export function parseJsonObject(text: string): JsonObject {
	const parsed = cleanAndParseJson(text);
	if (!isRecord(parsed)) throw new Error("Expected a JSON object.");
	return parsed;
}

function stripFences(text: string): string {
	return removeThinkTags(text)
		.replace(/```(?:json)?\s*/g, "")
		.trim();
}

function sanitizeControlCharacters(text: string): string {
	return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}

/** Returns the end index (exclusive) of the balanced object starting at `start`, or -1. */
function findBalancedEnd(text: string, start: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

/** Converts a Python dict literal (single quotes, True/False/None) into JSON text. */
export function pythonLiteralToJson(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === "'" || ch === '"') {
			let j = i + 1;
			let body = "";
			while (j < text.length && text[j] !== ch) {
				if (text[j] === "\\" && j + 1 < text.length) {
					const next = text[j + 1]!;
					body += next === "'" ? "'" : `\\${next}`;
					j += 2;
					continue;
				}
				body += text[j] === '"' ? '\\"' : text[j];
				j++;
			}
			out += `"${body}"`;
			i = j + 1;
			continue;
		}
		const word = /^(True|False|None)\b/.exec(text.slice(i));
		if (word && !/[A-Za-z0-9_]/.test(text[i - 1] ?? "")) {
			out += word[1] === "True" ? "true" : word[1] === "False" ? "false" : "null";
			i += word[1]!.length;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function tryParseObject(candidate: string): JsonObject | undefined {
	for (const attempt of [
		() => JSON.parse(candidate),
		() => JSON.parse(sanitizeControlCharacters(candidate)),
		() => JSON.parse(pythonLiteralToJson(candidate)),
	]) {
		try {
			const value = attempt();
			if (isRecord(value)) return value;
		} catch {
			// fall through to the next, more lenient strategy
		}
	}
	return undefined;
}

/**
 * Lenient parser for batch classification/judging responses: tolerates reasoning blocks,
 * code fences, stray leading braces, control characters, and Python-style literals.
 */
export function parseJsonResponse(raw: string): JsonObject {
	const cleaned = stripFences(raw);
	for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
		const end = findBalancedEnd(cleaned, start);
		const candidate = end === -1 ? cleaned.slice(start) : cleaned.slice(start, end);
		const parsed = tryParseObject(candidate);
		if (parsed) return parsed;
	}
	throw new Error(`No JSON found in response:\n${raw.slice(0, 300)}`);
}
