import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Criterion } from "../../src/artifacts/types.ts";
import { CorpusError, loadCorpus, parseCsv, parseJsonl, parseText } from "../../src/corpus/load.ts";
import { assignOpenCodeIds, buildCodeEvidence, codeIdMapFile, shortLabel } from "../../src/evidence/code-evidence.ts";
import {
	groundCriterionExamples,
	groundEnrichedEntries,
	loadOrBuildSourceMemory,
	parseOpenCodingSnippets,
	SourceMemory,
	saveSourceMemory,
	toGroundedExample,
} from "../../src/evidence/source-memory.ts";

const SAMPLE_MD = `## Review 1

- Code: chronic academic anxiety
  Evidence: "I can't even focus on homework anymore."
  Note: strong emotional tone

- Code: laggy matchmaking
  Evidence: "Servers take forever to find a game."

## Review 2

- Code: chronic academic anxiety
  Evidence: "Every test feels like a mountain."

## Review 3

Applicability: NONE
Reason: not relevant
Evidence: "ignored quote"
`;

describe("corpus loading", () => {
	it("reads CSV with the preferred text column and optional ids", () => {
		const docs = parseCsv('id,review_text,text_review\n7,"ignored","Laggy, slow"\n,"x","Great"\n', {});
		expect(docs).toEqual([
			{ reviewId: 1, text: "Laggy, slow", sourceId: "7" },
			{ reviewId: 2, text: "Great", sourceId: null },
		]);
	});

	it("honours configured columns and reports missing ones", () => {
		expect(parseCsv("body,key\nhello,k1\n", { textColumn: "body", idColumn: "key" })).toEqual([
			{ reviewId: 1, text: "hello", sourceId: "k1" },
		]);
		expect(() => parseCsv("body\nhello\n", {})).toThrow(/text_review/);
		expect(() => parseCsv("text\nhello\n", { idColumn: "nope" })).toThrow(CorpusError);
		expect(() => parseCsv("text\nhello\n", { textColumn: "nope" })).toThrow(/'nope'/);
	});

	it("handles BOM, quoted newlines, and TSV", () => {
		expect(parseCsv('﻿text\n"line one\nline two"\n', {})[0]!.text).toBe("line one\nline two");
		expect(parseCsv("text\tid\nhi\t3\n", {}, "\t")).toEqual([{ reviewId: 1, text: "hi", sourceId: "3" }]);
	});

	it("reads JSONL and plain text", () => {
		expect(parseJsonl('{"text": "a", "id": 1}\n\n{"text": "b"}\n', {})).toEqual([
			{ reviewId: 1, text: "a", sourceId: "1" },
			{ reviewId: 2, text: "b", sourceId: null },
		]);
		expect(() => parseJsonl("[1]\n", {})).toThrow(/not an object/);
		expect(() => parseJsonl("{bad\n", {})).toThrow(/not valid JSON/);
		expect(parseText("one\n\ntwo\r\n")).toEqual([
			{ reviewId: 1, text: "one", sourceId: null },
			{ reviewId: 2, text: "two", sourceId: null },
		]);
	});

	it("loads by extension and rejects empty or missing files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		await writeFile(join(dir, "a.jsonl"), '{"text": "x"}\n', "utf8");
		await writeFile(join(dir, "b.csv"), "text\n", "utf8");
		expect(await loadCorpus(join(dir, "a.jsonl"))).toHaveLength(1);
		await expect(loadCorpus(join(dir, "b.csv"))).rejects.toThrow(/no documents/);
		await expect(loadCorpus(join(dir, "none.csv"))).rejects.toThrow(/Cannot read/);
	});
});

describe("parseOpenCodingSnippets", () => {
	it("extracts review-aware snippets and skips NONE reviews", () => {
		const snippets = parseOpenCodingSnippets(SAMPLE_MD);
		expect(snippets).toHaveLength(3);
		expect(snippets[0]).toMatchObject({
			snippet_id: "SNIP-0001",
			review_id: 1,
			open_code: "chronic academic anxiety",
			quote: "I can't even focus on homework anymore.",
			note: "strong emotional tone",
		});
		expect(snippets[1]!.note).toBe("");
		expect(snippets[2]!.review_id).toBe(2);
		expect(snippets.every((s) => s.quote !== "ignored quote")).toBe(true);
	});

	it("handles multi-line quotes and blocks that end the file", () => {
		const md = '## Review 9\n\n- Code: spans lines\n  Evidence: "first\nsecond"\n  Note: n';
		expect(parseOpenCodingSnippets(md)[0]).toMatchObject({ quote: "first\nsecond", note: "n" });
	});
});

describe("SourceMemory", () => {
	const memory = SourceMemory.build(SAMPLE_MD, {
		sourceIds: new Map([[1, "row-1"]]),
		codeToId: { "chronic academic anxiety": "OC001" },
	});

	it("attaches source and open-code ids", () => {
		expect(memory.snippets[0]).toMatchObject({ source_id: "row-1", open_code_id: "OC001" });
		expect(memory.reviews).toEqual([
			{ review_id: 1, source_id: "row-1" },
			{ review_id: 2, source_id: null },
		]);
	});

	it("picks the lowest unused review first, honouring a review hint", () => {
		const first = memory.pickSnippetForCode("chronic academic anxiety")!;
		expect(first.review_id).toBe(1);
		expect(memory.pickSnippetForCode("chronic academic anxiety", new Set([first.snippet_id]))!.review_id).toBe(2);
		expect(memory.pickSnippetForCode("chronic academic anxiety", new Set(), 2)!.review_id).toBe(2);
		expect(memory.pickSnippetForCode("unknown")).toBeUndefined();
	});

	it("grounds quotes, disambiguating by open code", () => {
		const g = memory.groundQuote("  I can't even focus on homework anymore. ", {
			openCode: "chronic academic anxiety",
		});
		expect(g).toMatchObject({ review_id: 1, open_code: "chronic academic anxiety", open_code_id: "OC001" });
		expect(memory.groundQuote("never said")).toBeUndefined();
	});

	it("resolves duplicate quotes to the earliest review", () => {
		const dup = SourceMemory.build(
			'## Review 2\n\n- Code: b\n  Evidence: "same"\n\n## Review 1\n\n- Code: a\n  Evidence: "same"\n',
		);
		expect(dup.groundQuote("same")!.review_id).toBe(1);
		expect(dup.groundQuote("same", { openCode: "b" })!.review_id).toBe(2);
	});

	it("aggregates evidence per code", () => {
		const { quotes, notes } = memory.evidenceByCode();
		expect(quotes.get("chronic academic anxiety")).toEqual([
			"I can't even focus on homework anymore.",
			"Every test feels like a mountain.",
		]);
		expect(notes.get("chronic academic anxiety")).toEqual(["strong emotional tone"]);
		expect(notes.get("laggy matchmaking")).toEqual([]);
	});

	it("round-trips through JSON", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		await saveSourceMemory(join(dir, "m.json"), memory);
		const loaded = SourceMemory.fromJSON(memory.toJSON());
		expect(loaded.snippets).toEqual(memory.snippets);
		expect(loaded.toJSON().by_snippet_id["SNIP-0001"]).toBe(0);
		expect(loaded.toJSON().by_quote["I can't even focus on homework anymore."]).toEqual(["SNIP-0001"]);
	});

	it("rebuilds when the markdown is newer or code ids are supplied", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const markdownPath = join(dir, "open.md");
		const memoryPath = join(dir, "memory.json");
		await writeFile(markdownPath, SAMPLE_MD, "utf8");
		const built = await loadOrBuildSourceMemory({ markdownPath, memoryPath });
		expect(built.snippets).toHaveLength(3);
		await writeFile(markdownPath, `${SAMPLE_MD}\n## Review 4\n\n- Code: new\n  Evidence: "fresh"\n`, "utf8");
		const future = new Date(Date.now() + 10_000);
		await utimes(markdownPath, future, future);
		expect((await loadOrBuildSourceMemory({ markdownPath, memoryPath })).snippets).toHaveLength(4);
		const cached = await loadOrBuildSourceMemory({ markdownPath, memoryPath: memoryPath });
		expect(cached.snippets).toHaveLength(4);
		const withIds = await loadOrBuildSourceMemory({ markdownPath, memoryPath, codeToId: { new: "OC009" } });
		expect(withIds.snippets.at(-1)!.open_code_id).toBe("OC009");
	});
});

describe("grounding examples", () => {
	const memory = SourceMemory.build(SAMPLE_MD);

	it("converts string examples into snippet objects", () => {
		const item: Criterion = {
			criterion: "c",
			code_ids: ["LC001"],
			examples: ["I can't even focus on homework anymore."],
		};
		groundCriterionExamples(item, memory, { openCode: () => "chronic academic anxiety" });
		expect(item.examples).toEqual([toGroundedExample(memory.snippets[0]!)]);
	});

	it("keeps grounded examples, uses cluster codes, and drops unknown quotes", () => {
		const grounded = toGroundedExample(memory.snippets[1]!);
		const item: Criterion = {
			criterion: "c",
			code_ids: ["CL00", "CL01", "CL02"],
			examples: [grounded, "Every test feels like a mountain.", "made up"],
		};
		groundEnrichedEntries([{ label: "L", definition: "", keywords: [], inclusion: [item], exclusion: [] }], memory, {
			clusterCodes: () => ["chronic academic anxiety"],
		});
		expect(item.examples).toHaveLength(2);
		expect(item.examples![1]).toMatchObject({ review_id: 2 });
	});
});

describe("code evidence", () => {
	it("assigns stable OC ids in cluster order", () => {
		const ids = assignOpenCodeIds({ "10": ["z"], "2": ["b", "a"], "1": ["a"] });
		expect(ids).toEqual({ a: "OC001", b: "OC002", z: "OC003" });
		expect(codeIdMapFile(ids).id_to_code).toEqual({ OC001: "a", OC002: "b", OC003: "z" });
	});

	it("strips rich label suffixes", () => {
		expect(shortLabel("Lag | Definition: slow")).toBe("Lag");
		expect(shortLabel("")).toBe("");
	});

	it("collects snippets for canonical codes including merged aliases", () => {
		const memory = SourceMemory.build(
			'## Review 2\n\n- Code: Slow load\n  Evidence: "q2"\n\n## Review 1\n\n- Code: slow load\n  Evidence: "q1"\n',
		);
		const evidence = buildCodeEvidence(memory, {
			slug: "s",
			researchQuestion: "rq",
			openCodes: ["slow load", "unseen"],
			dedupMap: { "Slow load": "slow load" },
		});
		expect(evidence.by_open_code["slow load"]).toMatchObject({ quote_count: 2, review_count: 2 });
		expect(evidence.by_open_code["slow load"]!.primary!.quote).toBe("q1");
		expect(evidence.by_open_code.unseen).toEqual({ quote_count: 0, review_count: 0, primary: null, snippets: [] });
		expect(evidence.generated_at).toMatch(/Z$/);
		expect(Object.keys(buildCodeEvidence(memory, { slug: "s", researchQuestion: "" }).by_open_code)).toEqual([
			"Slow load",
			"slow load",
		]);
	});
});
