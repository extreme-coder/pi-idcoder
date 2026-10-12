/** Extracts `- Code: <label>` lines from open-coding output (evidence and notes are ignored). */
export function extractCodes(openCodingText: string): string[] {
	if (!openCodingText.trim()) return [];
	const codes: string[] = [];
	for (const match of openCodingText.matchAll(/^-\s*Code:\s*(.+)$/gim)) {
		const code = match[1]!.trim();
		if (code) codes.push(code);
	}
	return codes;
}

export function normalizeQuote(quote: string): string {
	return quote.trim().normalize("NFKC");
}

export function squashWhitespace(text: string): string {
	return text.split(/\s+/).filter(Boolean).join(" ");
}

export function bulleted(items: readonly string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

export function uniqueInOrder<T>(items: Iterable<T>): T[] {
	return [...new Set(items)];
}

/**
 * Whether a quote appears in known evidence: substring containment either way, or (for quotes of
 * six or more distinct words) at least 80% word overlap with one evidence item.
 */
export function quoteInEvidence(quote: string, known: readonly string[]): boolean {
	const q = squashWhitespace(quote).toLowerCase();
	if (!q) return true;
	const normalizedKnown = known.map((ev) => squashWhitespace(ev).toLowerCase());
	if (normalizedKnown.some((ev) => q.includes(ev) || ev.includes(q))) return true;
	const qWords = new Set(q.split(" "));
	if (qWords.size < 6 || normalizedKnown.length === 0) return false;
	let best = 0;
	for (const ev of normalizedKnown) {
		const evWords = new Set(ev.split(" "));
		let shared = 0;
		for (const w of qWords) if (evWords.has(w)) shared++;
		best = Math.max(best, shared / qWords.size);
	}
	return best >= 0.8;
}

export function truncate(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "default";
}
