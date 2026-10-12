import type { ClusterToCodes } from "../artifacts/types.ts";
import { openCodeId, sortClusterIds } from "../core/ids.ts";
import type { Snippet, SourceMemory } from "./source-memory.ts";

export interface EvidenceSnippet {
	snippet_id: string;
	review_id: number;
	source_id: string | null;
	quote: string;
	note: string;
}

export interface CodeEvidenceEntry {
	quote_count: number;
	review_count: number;
	primary: EvidenceSnippet | null;
	snippets: EvidenceSnippet[];
}

export interface CodeEvidenceFile {
	version: 1;
	slug: string;
	research_question: string;
	generated_at: string;
	by_open_code: Record<string, CodeEvidenceEntry>;
}

/** Strips rich-label suffixes (`label | Definition: ...`) so re-runs stay idempotent. */
export function shortLabel(label: string): string {
	return label ? label.split(" | ")[0]!.trim() : label;
}

/** Stable `OC001` ids for every distinct open code, in cluster order. */
export function assignOpenCodeIds(clusterToCodes: ClusterToCodes): Record<string, string> {
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const cid of sortClusterIds(Object.keys(clusterToCodes))) {
		for (const code of clusterToCodes[cid] ?? []) {
			if (!seen.has(code)) {
				seen.add(code);
				ordered.push(code);
			}
		}
	}
	return Object.fromEntries(ordered.map((code, i) => [code, openCodeId(i)]));
}

export function codeIdMapFile(codeToId: Record<string, string>): {
	code_to_id: Record<string, string>;
	id_to_code: Record<string, string>;
} {
	return {
		code_to_id: codeToId,
		id_to_code: Object.fromEntries(Object.entries(codeToId).map(([code, id]) => [id, code])),
	};
}

function payload(s: Snippet): EvidenceSnippet {
	return { snippet_id: s.snippet_id, review_id: s.review_id, source_id: s.source_id, quote: s.quote, note: s.note };
}

/**
 * Groups source snippets by (canonical) open code for the review viewer's hover quotes. A
 * canonical code also collects the snippets of every original spelling merged into it.
 */
export function buildCodeEvidence(
	memory: SourceMemory,
	options: { slug: string; researchQuestion: string; openCodes?: Iterable<string>; dedupMap?: Record<string, string> },
): CodeEvidenceFile {
	const aliases = new Map<string, Set<string>>();
	for (const [original, canonical] of Object.entries(options.dedupMap ?? {})) {
		aliases.set(canonical, (aliases.get(canonical) ?? new Set()).add(original));
	}
	const codes = options.openCodes
		? [...new Set(options.openCodes)]
		: [...new Set(memory.snippets.map((s) => s.open_code))];
	const byOpenCode: Record<string, CodeEvidenceEntry> = {};
	for (const code of codes.sort()) {
		const seen = new Set<string>();
		const collected: Snippet[] = [];
		for (const alias of [code, ...(aliases.get(code) ?? [])]) {
			for (const s of memory.snippetsForCode(alias)) {
				if (seen.has(s.snippet_id)) continue;
				seen.add(s.snippet_id);
				collected.push(s);
			}
		}
		collected.sort((a, b) => a.review_id - b.review_id || a.snippet_id.localeCompare(b.snippet_id));
		const snippets = collected.map(payload);
		byOpenCode[code] = {
			quote_count: snippets.length,
			review_count: new Set(collected.map((s) => s.review_id)).size,
			primary: snippets[0] ?? null,
			snippets,
		};
	}
	return {
		version: 1,
		slug: options.slug,
		research_question: options.researchQuestion,
		generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		by_open_code: byOpenCode,
	};
}
