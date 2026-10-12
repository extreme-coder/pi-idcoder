import type { Criterion, EnrichedEntry, GroundedExample } from "../artifacts/types.ts";
import { fileExists, mtimeMs, readJson, readText, writeJson } from "../core/fs.ts";
import { snippetId } from "../core/ids.ts";
import { isRecord } from "../core/json.ts";
import { type Logger, silentLogger } from "../core/logger.ts";
import { normalizeQuote } from "../core/text.ts";

export const MEMORY_VERSION = 1;

export interface Snippet {
	snippet_id: string;
	review_id: number;
	source_id: string | null;
	open_code: string;
	open_code_id: string | null;
	quote: string;
	note: string;
}

export interface SourceMemoryFile {
	version: number;
	data_csv: string;
	reviews: Array<{ review_id: number; source_id: string | null }>;
	snippets: Snippet[];
	by_snippet_id: Record<string, number>;
	by_quote: Record<string, string[]>;
}

const CODE_EVIDENCE =
	/-\s*Code:\s*(.+?)\s*\n\s+Evidence:\s*"(.+?)"\s*(?:\n\s+Note:\s*(.+?)\s*)?(?=\n\s*-\s*(?:Code:|Applicability:)|\n##|$)/gis;

/** Parses the per-review open-coding markdown into snippet records (reviews marked NONE are skipped). */
export function parseOpenCodingSnippets(markdown: string): Snippet[] {
	const parts = markdown.split(/^## Review (\d+)\s*$/m);
	const snippets: Snippet[] = [];
	for (let i = 1; i < parts.length; i += 2) {
		const reviewId = Number(parts[i]);
		const block = parts[i + 1] ?? "";
		if (/Applicability:\s*NONE/i.test(block)) continue;
		for (const match of block.matchAll(CODE_EVIDENCE)) {
			const quote = match[2]!.trim();
			if (!quote) continue;
			snippets.push({
				snippet_id: snippetId(snippets.length + 1),
				review_id: reviewId,
				source_id: null,
				open_code: match[1]!.trim(),
				open_code_id: null,
				quote,
				note: (match[3] ?? "").trim(),
			});
		}
	}
	return snippets;
}

export function toGroundedExample(s: Snippet): GroundedExample {
	return {
		snippet_id: s.snippet_id,
		review_id: s.review_id,
		source_id: s.source_id,
		open_code_id: s.open_code_id,
		open_code: s.open_code,
		quote: s.quote,
	};
}

/** Deterministic index from quotes to the review and open code that produced them. */
export class SourceMemory {
	readonly version: number;
	readonly dataPath: string;
	readonly reviews: SourceMemoryFile["reviews"];
	readonly snippets: readonly Snippet[];
	private readonly bySnippetId = new Map<string, number>();
	private readonly byQuote = new Map<string, string[]>();
	private readonly byOpenCode = new Map<string, number[]>();
	private readonly logger: Logger;

	private constructor(
		snippets: Snippet[],
		dataPath: string,
		reviews: SourceMemoryFile["reviews"],
		version: number,
		logger: Logger,
	) {
		this.snippets = snippets;
		this.dataPath = dataPath;
		this.reviews = reviews;
		this.version = version;
		this.logger = logger;
		snippets.forEach((s, i) => {
			this.bySnippetId.set(s.snippet_id, i);
			const key = normalizeQuote(s.quote);
			this.byQuote.set(key, [...(this.byQuote.get(key) ?? []), s.snippet_id]);
			this.byOpenCode.set(s.open_code, [...(this.byOpenCode.get(s.open_code) ?? []), i]);
		});
	}

	static build(
		markdown: string,
		options: {
			sourceIds?: ReadonlyMap<number, string | null>;
			codeToId?: Readonly<Record<string, string>>;
			dataPath?: string;
			logger?: Logger;
		} = {},
	): SourceMemory {
		const snippets = parseOpenCodingSnippets(markdown).map((s) => ({
			...s,
			source_id: options.sourceIds?.get(s.review_id) ?? null,
			open_code_id: options.codeToId?.[s.open_code] ?? null,
		}));
		const reviewIds = [...new Set(snippets.map((s) => s.review_id))].sort((a, b) => a - b);
		const reviews = reviewIds.map((id) => ({ review_id: id, source_id: options.sourceIds?.get(id) ?? null }));
		return new SourceMemory(
			snippets,
			options.dataPath ?? "",
			reviews,
			MEMORY_VERSION,
			options.logger ?? silentLogger,
		);
	}

	static fromJSON(data: SourceMemoryFile, logger: Logger = silentLogger): SourceMemory {
		const snippets = data.snippets.map((s) => ({
			snippet_id: s.snippet_id,
			review_id: Number(s.review_id),
			source_id: s.source_id ?? null,
			open_code: s.open_code,
			open_code_id: s.open_code_id ?? null,
			quote: s.quote,
			note: s.note ?? "",
		}));
		return new SourceMemory(
			snippets,
			data.data_csv ?? "",
			data.reviews ?? [],
			data.version ?? MEMORY_VERSION,
			logger,
		);
	}

	toJSON(): SourceMemoryFile {
		return {
			version: this.version,
			data_csv: this.dataPath,
			reviews: [...this.reviews],
			snippets: [...this.snippets],
			by_snippet_id: Object.fromEntries(this.bySnippetId),
			by_quote: Object.fromEntries(this.byQuote),
		};
	}

	snippetAt(id: string): Snippet | undefined {
		const index = this.bySnippetId.get(id);
		return index === undefined ? undefined : this.snippets[index];
	}

	snippetsForCode(openCode: string): Snippet[] {
		return (this.byOpenCode.get(openCode) ?? []).map((i) => this.snippets[i]!);
	}

	/** First unused snippet for a code, lowest review id first (a hinted review wins ties). */
	pickSnippetForCode(
		openCode: string,
		used: ReadonlySet<string> = new Set(),
		reviewHint?: number,
	): Snippet | undefined {
		const indices = [...(this.byOpenCode.get(openCode) ?? [])].sort((a, b) => {
			const sa = this.snippets[a]!;
			const sb = this.snippets[b]!;
			const ha = reviewHint !== undefined && sa.review_id === reviewHint ? 0 : 1;
			const hb = reviewHint !== undefined && sb.review_id === reviewHint ? 0 : 1;
			return ha - hb || sa.review_id - sb.review_id || a - b;
		});
		for (const i of indices) {
			const s = this.snippets[i]!;
			if (!used.has(s.snippet_id)) return s;
		}
		return undefined;
	}

	groundQuote(quote: string, filter: { openCode?: string; openCodeId?: string } = {}): GroundedExample | undefined {
		const ids = this.byQuote.get(normalizeQuote(quote)) ?? [];
		if (ids.length === 0) {
			this.logger.warn("GROUND_WARN", `No snippet for quote: ${JSON.stringify(quote.slice(0, 80))}`);
			return undefined;
		}
		let candidates = ids.map((id) => this.snippetAt(id)).filter((s): s is Snippet => s !== undefined);
		if (filter.openCodeId) {
			const narrowed = candidates.filter((c) => c.open_code_id === filter.openCodeId);
			if (narrowed.length) candidates = narrowed;
		}
		if (filter.openCode) {
			const narrowed = candidates.filter((c) => c.open_code === filter.openCode);
			if (narrowed.length) candidates = narrowed;
		}
		if (candidates.length > 1) {
			candidates.sort((a, b) => a.review_id - b.review_id || a.snippet_id.localeCompare(b.snippet_id));
			this.logger.warn(
				"GROUND_WARN",
				`Ambiguous quote resolved to ${candidates[0]!.snippet_id} (${ids.length} matches)`,
			);
		}
		return candidates[0] ? toGroundedExample(candidates[0]) : undefined;
	}

	/** Quotes and notes per open code, de-duplicated, in snippet order. */
	evidenceByCode(): { quotes: Map<string, string[]>; notes: Map<string, string[]> } {
		const quotes = new Map<string, string[]>();
		const notes = new Map<string, string[]>();
		for (const s of this.snippets) {
			const q = quotes.get(s.open_code) ?? [];
			if (!q.includes(s.quote)) q.push(s.quote);
			quotes.set(s.open_code, q);
			const n = notes.get(s.open_code) ?? [];
			if (s.note && !n.includes(s.note)) n.push(s.note);
			notes.set(s.open_code, n);
		}
		return { quotes, notes };
	}
}

export async function saveSourceMemory(path: string, memory: SourceMemory): Promise<void> {
	await writeJson(path, memory.toJSON());
}

/** Loads the cached index unless the open-coding markdown is newer, otherwise rebuilds and saves it. */
export async function loadOrBuildSourceMemory(options: {
	markdownPath: string;
	memoryPath: string;
	sourceIds?: ReadonlyMap<number, string | null>;
	codeToId?: Readonly<Record<string, string>>;
	dataPath?: string;
	logger?: Logger;
}): Promise<SourceMemory> {
	const logger = options.logger ?? silentLogger;
	const memoryTime = await mtimeMs(options.memoryPath);
	const markdownTime = await mtimeMs(options.markdownPath);
	if (memoryTime !== undefined && markdownTime !== undefined && memoryTime >= markdownTime && !options.codeToId) {
		try {
			return SourceMemory.fromJSON(await readJson<SourceMemoryFile>(options.memoryPath), logger);
		} catch {
			logger.warn("SOURCE_MEMORY", "Corrupt memory file — rebuilding");
		}
	}
	const markdown = (await fileExists(options.markdownPath)) ? await readText(options.markdownPath) : "";
	const memory = SourceMemory.build(markdown, { ...options, logger });
	await saveSourceMemory(options.memoryPath, memory);
	return memory;
}

function exampleQuote(example: unknown): string {
	return isRecord(example) ? String(example.quote ?? "") : String(example);
}

/** Converts string examples of one criterion into grounded snippet objects, in place. */
export function groundCriterionExamples(
	item: Criterion,
	memory: SourceMemory,
	resolvers: {
		openCode?: (codeId: string) => string | undefined;
		clusterCodes?: (codeId: string) => readonly string[];
	},
): void {
	if (!item.examples?.length) return;
	const grounded: GroundedExample[] = [];
	item.examples.forEach((example, i) => {
		if (isRecord(example) && example.snippet_id) {
			grounded.push(example as GroundedExample);
			return;
		}
		const quote = exampleQuote(example);
		const codeId = item.code_ids[i];
		let candidates: readonly string[] = [];
		if (codeId !== undefined && resolvers.clusterCodes) candidates = resolvers.clusterCodes(codeId);
		else if (codeId !== undefined && resolvers.openCode) {
			const resolved = resolvers.openCode(codeId);
			candidates = resolved ? [resolved] : [];
		}
		let match: GroundedExample | undefined;
		for (const code of candidates) {
			match = memory.groundQuote(quote, { openCode: code });
			if (match) break;
		}
		match ??= memory.groundQuote(quote);
		if (match) grounded.push(match);
	});
	item.examples = grounded;
}

export function groundEnrichedEntries(
	entries: Iterable<EnrichedEntry>,
	memory: SourceMemory,
	resolvers: Parameters<typeof groundCriterionExamples>[2],
): void {
	for (const entry of entries) {
		for (const item of [...(entry.inclusion ?? []), ...(entry.exclusion ?? [])]) {
			groundCriterionExamples(item, memory, resolvers);
		}
	}
}
