import { describe, expect, it } from "vitest";
import {
	clusterTag,
	compareClusterIds,
	localCodeId,
	openCodeId,
	optionLetter,
	rawClusterId,
	snippetId,
	sortClusterIds,
} from "../../src/core/ids.ts";
import { Rng } from "../../src/core/random.ts";
import { extractCodes, normalizeQuote, quoteInEvidence, slugify, squashWhitespace } from "../../src/core/text.ts";

describe("extractCodes", () => {
	it("returns nothing for blank input", () => {
		expect(extractCodes("")).toEqual([]);
		expect(extractCodes("   ")).toEqual([]);
	});

	it("reads code lines case-insensitively", () => {
		const blob = "Some preamble\n- Code: Alpha theme\n- Code: Beta angle\n- code: lowercase ok\n";
		expect(extractCodes(blob)).toEqual(["Alpha theme", "Beta angle", "lowercase ok"]);
	});

	it("returns nothing for an Applicability NONE block", () => {
		expect(extractCodes('- Applicability: NONE\n  Reason: Off-topic.\n  Evidence: "generic"')).toEqual([]);
	});
});

describe("quoteInEvidence", () => {
	const known = ["The servers take forever to find a game for me tonight"];

	it("accepts substrings either way", () => {
		expect(quoteInEvidence("take forever", known)).toBe(true);
		expect(quoteInEvidence("Oh, the servers take forever to find a game for me tonight!!", known)).toBe(true);
		expect(quoteInEvidence("matchmaking is broken", known)).toBe(false);
		expect(quoteInEvidence("the servers  take\nforever to find a game for me tonight", known)).toBe(true);
	});

	it("requires exact containment for short quotes", () => {
		expect(quoteInEvidence("servers forever game", known)).toBe(false);
	});

	it("accepts long quotes with 80% word overlap", () => {
		expect(quoteInEvidence("servers take forever to find a game for us tonight", known)).toBe(true);
	});

	it("treats empty quotes as present", () => {
		expect(quoteInEvidence("   ", known)).toBe(true);
	});
});

describe("text helpers", () => {
	it("normalizes quotes with NFKC", () => {
		expect(normalizeQuote("  ﬁne  ")).toBe("fine");
	});

	it("squashes whitespace", () => {
		expect(squashWhitespace(" a \n b\t c ")).toBe("a b c");
	});

	it("slugifies research questions", () => {
		expect(slugify("What do Students say about Burnout?")).toBe("what-do-students-say-about-burnout");
		expect(slugify("???")).toBe("default");
	});
});

describe("ids", () => {
	it("sorts numeric ids numerically and strings after", () => {
		expect(sortClusterIds(["10", "2", "0b", "1", "0a"])).toEqual(["1", "2", "10", "0a", "0b"]);
		expect(compareClusterIds("3", "3")).toBe(0);
	});

	it("formats prompt ids", () => {
		expect(localCodeId(0)).toBe("LC001");
		expect(openCodeId(41)).toBe("OC042");
		expect(snippetId(7)).toBe("SNIP-0007");
		expect(clusterTag("5")).toBe("CL05");
		expect(clusterTag("12")).toBe("CL12");
		expect(rawClusterId("CL05")).toBe("5");
		expect(rawClusterId("weird")).toBe("weird");
		expect(optionLetter(2)).toBe("C");
	});
});

describe("Rng", () => {
	it("is deterministic per seed", () => {
		const a = new Rng(42);
		const b = new Rng(42);
		expect([a.next(), a.next(), a.next()]).toEqual([b.next(), b.next(), b.next()]);
	});

	it("produces values in [0, 1)", () => {
		const rng = new Rng(1);
		for (let i = 0; i < 1000; i++) {
			const v = rng.next();
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it("shuffles into a permutation without mutating input", () => {
		const input = [1, 2, 3, 4, 5, 6];
		const out = new Rng(3).shuffle(input);
		expect(input).toEqual([1, 2, 3, 4, 5, 6]);
		expect([...out].sort()).toEqual(input);
	});

	it("samples without replacement and caps at length", () => {
		const s = new Rng(9).sample([1, 2, 3, 4], 3);
		expect(new Set(s).size).toBe(3);
		expect(new Rng(9).sample([1, 2], 5)).toHaveLength(2);
	});

	it("forks independent but reproducible streams", () => {
		const base = new Rng(5);
		expect(base.fork("a").next()).toBe(new Rng(5).fork("a").next());
		expect(base.fork("a").next()).not.toBe(base.fork("b").next());
	});
});
