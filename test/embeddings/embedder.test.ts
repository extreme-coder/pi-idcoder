import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import {
	CachingEmbedder,
	createEmbedder,
	EmbeddingError,
	type FetchLike,
	OpenAICompatibleEmbedder,
	parseEmbeddingResponse,
	TransformersEmbedder,
} from "../../src/embeddings/embedder.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";

const base = resolveConfig({ study: { researchQuestion: "q", data: "d.csv" } }).embeddings;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpenAICompatibleEmbedder", () => {
	it("batches, reorders by index, normalizes, and authenticates", async () => {
		const requests: Array<{
			url: string;
			body: { input: string[]; model: string; dimensions?: number };
			auth: string | null;
		}> = [];
		const fetchImpl: FetchLike = async (url, init) => {
			const body = JSON.parse(String(init.body));
			requests.push({ url, body, auth: new Headers(init.headers).get("authorization") });
			const data = body.input
				.map((text: string, i: number) => ({ index: i, embedding: [text.length, 0] }))
				.reverse();
			return jsonResponse({ data });
		};
		const embedder = new OpenAICompatibleEmbedder(
			{ ...base, batchSize: 2, baseUrl: "http://x/v1/", dimensions: 256 },
			{ fetch: fetchImpl, env: { OPENAI_API_KEY: "sk-test" } },
		);
		const m = await embedder.embed(["a", "bb", "ccc"]);
		expect(requests.map((r) => r.body.input)).toEqual([["a", "bb"], ["ccc"]]);
		expect(requests[0]).toMatchObject({ url: "http://x/v1/embeddings", auth: "Bearer sk-test" });
		expect(requests[0]!.body).toMatchObject({ model: "text-embedding-3-small", dimensions: 256 });
		expect(m.rows).toBe(3);
		expect(Array.from(m.row(2))).toEqual([1, 0]);
	});

	it("omits authorization when no key is configured", async () => {
		let auth: string | null = "unset";
		const embedder = new OpenAICompatibleEmbedder(base, {
			fetch: async (_url, init) => {
				auth = new Headers(init.headers).get("authorization");
				return jsonResponse({ data: [{ index: 0, embedding: [1] }] });
			},
			env: {},
		});
		await embedder.embed(["x"]);
		expect(auth).toBeNull();
	});

	it("retries transient HTTP failures", async () => {
		let calls = 0;
		const embedder = new OpenAICompatibleEmbedder(base, {
			fetch: async () =>
				++calls < 3 ? new Response("busy", { status: 503 }) : jsonResponse({ data: [{ embedding: [1, 1] }] }),
			retryBaseMs: 0,
		});
		await embedder.embed(["x"]);
		expect(calls).toBe(3);
	});

	it("explains a missing API key on 401", async () => {
		const embedder = new OpenAICompatibleEmbedder(base, {
			fetch: async () => new Response("unauthorized", { status: 401 }),
			env: {},
		});
		await expect(embedder.embed(["x"])).rejects.toThrow(/set \$OPENAI_API_KEY/);
	});

	it("fails fast on permanent errors", async () => {
		let calls = 0;
		const embedder = new OpenAICompatibleEmbedder(base, {
			fetch: async () => {
				calls++;
				return new Response("bad key", { status: 401 });
			},
			retryBaseMs: 0,
		});
		await expect(embedder.embed(["x"])).rejects.toThrow(/401/);
		expect(calls).toBe(1);
	});

	it("returns an empty matrix for no input", async () => {
		const embedder = new OpenAICompatibleEmbedder(base, { fetch: async () => jsonResponse({ data: [] }) });
		expect((await embedder.embed([])).rows).toBe(0);
	});
});

describe("parseEmbeddingResponse", () => {
	it("rejects malformed payloads", () => {
		expect(() => parseEmbeddingResponse({}, 1)).toThrow(EmbeddingError);
		expect(() => parseEmbeddingResponse({ data: [{ embedding: [1] }] }, 2)).toThrow(/expected 2/);
		expect(() => parseEmbeddingResponse({ data: [{ embedding: "base64" }] }, 1)).toThrow(/base64/);
	});
});

describe("CachingEmbedder", () => {
	it("embeds each distinct text once and preserves order and duplicates", async () => {
		const inner = new HashingEmbedder(16);
		const cached = new CachingEmbedder(inner);
		const first = await cached.embed(["a", "b", "a"]);
		const second = await cached.embed(["b", "c"]);
		expect(inner.calls).toEqual([["a", "b"], ["c"]]);
		expect(Array.from(first.row(0))).toEqual(Array.from(first.row(2)));
		expect(Array.from(second.row(0))).toEqual(Array.from(first.row(1)));
		expect((await cached.embed([])).rows).toBe(0);
	});
});

describe("createEmbedder", () => {
	it("builds a cached embedder for either provider", () => {
		expect(createEmbedder(base)).toBeInstanceOf(CachingEmbedder);
		expect(createEmbedder({ ...base, provider: "transformers" })).toBeInstanceOf(CachingEmbedder);
	});

	it("explains how to install the optional local backend", async () => {
		const missing = () => Promise.reject(new Error("Cannot find package '@huggingface/transformers'"));
		const embedder = new TransformersEmbedder({ ...base, provider: "transformers", model: "x" }, missing);
		await expect(embedder.embed(["a"])).rejects.toThrow(/@huggingface\/transformers/);
	});
});
