import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import { isRecord } from "../core/json.ts";

export interface CorpusDocument {
	/** 1-based position in the corpus; the original pipeline's "review id". */
	reviewId: number;
	text: string;
	sourceId: string | null;
}

export interface CorpusOptions {
	textColumn?: string | undefined;
	idColumn?: string | undefined;
}

export class CorpusError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorpusError";
	}
}

const TEXT_COLUMNS = ["text_review", "review_text", "text"];
const ID_COLUMNS = ["id", "csv_id", "review_id"];

function pickColumn(
	columns: readonly string[],
	explicit: string | undefined,
	candidates: readonly string[],
): string | undefined {
	if (explicit) return columns.includes(explicit) ? explicit : undefined;
	return candidates.find((c) => columns.includes(c));
}

function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	return typeof value === "string" ? value : String(value);
}

function fromRows(
	rows: Record<string, unknown>[],
	columns: readonly string[],
	options: CorpusOptions,
): CorpusDocument[] {
	const textColumn = pickColumn(columns, options.textColumn, TEXT_COLUMNS);
	if (!textColumn) {
		const wanted = options.textColumn ? `'${options.textColumn}'` : TEXT_COLUMNS.map((c) => `'${c}'`).join(" or ");
		throw new CorpusError(`Corpus must have a ${wanted} column; found ${columns.join(", ") || "none"}.`);
	}
	if (options.idColumn && !columns.includes(options.idColumn)) {
		throw new CorpusError(`Configured id column '${options.idColumn}' is missing; found ${columns.join(", ")}.`);
	}
	const idColumn = pickColumn(columns, options.idColumn, ID_COLUMNS);
	return rows.map((row, i) => {
		const id = idColumn ? cell(row[idColumn]).trim() : "";
		return { reviewId: i + 1, text: cell(row[textColumn]), sourceId: id || null };
	});
}

export function parseCsv(content: string, options: CorpusOptions, delimiter = ","): CorpusDocument[] {
	const rows = parse(content, {
		columns: true,
		bom: true,
		delimiter,
		relax_column_count: true,
		skip_empty_lines: true,
	}) as Record<string, string>[];
	const header = parse(content, { bom: true, delimiter, to_line: 1, relax_column_count: true }) as string[][];
	return fromRows(rows, header[0] ?? [], options);
}

export function parseJsonl(content: string, options: CorpusOptions): CorpusDocument[] {
	const rows: Record<string, unknown>[] = [];
	content.split("\n").forEach((line, i) => {
		if (!line.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			throw new CorpusError(`Line ${i + 1} of the JSONL corpus is not valid JSON.`);
		}
		if (!isRecord(value)) throw new CorpusError(`Line ${i + 1} of the JSONL corpus is not an object.`);
		rows.push(value);
	});
	const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
	return fromRows(rows, columns, options);
}

/** One document per non-empty line. */
export function parseText(content: string): CorpusDocument[] {
	return content
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.map((text, i) => ({ reviewId: i + 1, text, sourceId: null }));
}

export async function loadCorpus(path: string, options: CorpusOptions = {}): Promise<CorpusDocument[]> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		throw new CorpusError(`Cannot read corpus at ${path}: ${(error as Error).message}`);
	}
	const ext = extname(path).toLowerCase();
	const documents =
		ext === ".jsonl" || ext === ".ndjson"
			? parseJsonl(content, options)
			: ext === ".txt"
				? parseText(content)
				: parseCsv(content, options, ext === ".tsv" ? "\t" : ",");
	if (documents.length === 0) throw new CorpusError(`Corpus at ${path} has no documents.`);
	return documents;
}
