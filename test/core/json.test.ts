import { describe, expect, it } from "vitest";
import {
	asClampedInt,
	cleanAndParseJson,
	parseJsonObject,
	parseJsonResponse,
	pythonLiteralToJson,
	removeThinkTags,
} from "../../src/core/json.ts";

describe("removeThinkTags", () => {
	it("strips a single reasoning block", () => {
		expect(removeThinkTags("before <think>x</think> after").split(/\s+/)).toEqual(["before", "after"]);
	});

	it("strips multi-line blocks and trims", () => {
		expect(removeThinkTags("intro\n<think>\nline\n</think>\noutro")).toBe("intro\n\noutro");
	});

	it("is non-greedy across several blocks", () => {
		expect(removeThinkTags("<think>a</think>keep<think>b</think>")).toBe("keep");
	});
});

describe("cleanAndParseJson", () => {
	it("extracts the outer object from surrounding noise", () => {
		expect(cleanAndParseJson('noise {"a": 1, "b": [true]} trailing')).toEqual({ a: 1, b: [true] });
	});

	it("handles nested values and false", () => {
		expect(cleanAndParseJson('prefix {"items": [1, 2], "ok": false} suffix')).toEqual({ items: [1, 2], ok: false });
	});

	it("ignores braces inside think blocks", () => {
		expect(cleanAndParseJson('<think>{"wrong": 1}</think>{"right": 2}')).toEqual({ right: 2 });
	});

	it("throws without braces", () => {
		expect(() => cleanAndParseJson("no json here")).toThrow("No JSON brackets");
	});

	it("parseJsonObject rejects non-objects", () => {
		expect(() => parseJsonObject("[1]")).toThrow();
	});
});

describe("parseJsonResponse", () => {
	it("parses fenced JSON", () => {
		expect(parseJsonResponse('```json\n{"verdicts": []}\n```')).toEqual({ verdicts: [] });
	});

	it("skips a stray leading brace", () => {
		expect(parseJsonResponse('{ {"classifications": [{"quote_index": 1}]}')).toEqual({
			classifications: [{ quote_index: 1 }],
		});
	});

	it("tolerates trailing commentary after the object", () => {
		expect(parseJsonResponse('{"a": 1} hope this helps {')).toEqual({ a: 1 });
	});

	it("sanitizes raw control characters inside strings", () => {
		expect(parseJsonResponse('{"a": "line\u0001break"}')).toEqual({ a: "line break" });
	});

	it("accepts Python literals", () => {
		expect(parseJsonResponse("{'a': True, 'b': None, 'c': 'it\\'s'}")).toEqual({ a: true, b: null, c: "it's" });
	});

	it("does not treat braces inside strings as structure", () => {
		expect(parseJsonResponse('{"q": "has } brace", "n": 2}')).toEqual({ q: "has } brace", n: 2 });
	});

	it("throws when nothing parses", () => {
		expect(() => parseJsonResponse("nothing")).toThrow("No JSON found");
	});
});

describe("pythonLiteralToJson", () => {
	it("leaves identifiers containing True alone", () => {
		expect(pythonLiteralToJson("{'x': TrueValue}")).toBe('{"x": TrueValue}');
	});

	it("escapes embedded double quotes", () => {
		expect(JSON.parse(pythonLiteralToJson(`{'q': 'say "hi"'}`))).toEqual({ q: 'say "hi"' });
	});
});

describe("asClampedInt", () => {
	it.each([
		[4, 4],
		["3", 3],
		[4.9, 4],
		[9, 5],
		[-2, 1],
		["x", 1],
		[null, 1],
	])("%s -> %s", (input, expected) => {
		expect(asClampedInt(input, 1, 5, 1)).toBe(expected);
	});
});
