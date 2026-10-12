import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.ts";
import { TransformersEmbedder } from "../../src/embeddings/embedder.ts";

const embeddings = resolveConfig({ study: { researchQuestion: "q", data: "d.csv" } }).embeddings;

describe("TransformersEmbedder", () => {
	it("loads the pipeline once, batches, and normalizes", async () => {
		const loads: string[] = [];
		const batches: string[][] = [];
		const embedder = new TransformersEmbedder(
			{
				...embeddings,
				provider: "transformers",
				model: "onnx/qwen",
				batchSize: 2,
				pooling: "last_token",
				dtype: "q8",
			},
			async () => ({
				pipeline: async (task, model, options) => {
					loads.push(`${task}:${model}:${JSON.stringify(options)}`);
					return async (texts, opts) => {
						batches.push(texts);
						expect(opts).toEqual({ pooling: "last_token", normalize: true });
						return { tolist: () => texts.map((t) => [t.length, 0]) };
					};
				},
			}),
		);
		const m = await embedder.embed(["a", "bb", "ccc"]);
		await embedder.embed(["d"]);
		expect(loads).toEqual(['feature-extraction:onnx/qwen:{"dtype":"q8"}']);
		expect(batches).toEqual([["a", "bb"], ["ccc"], ["d"]]);
		expect(Array.from(m.row(2))).toEqual([1, 0]);
		expect((await embedder.embed([])).rows).toBe(0);
	});

	it("stops between batches when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const embedder = new TransformersEmbedder({ ...embeddings, provider: "transformers" }, async () => ({
			pipeline: async () => async () => ({ tolist: () => [] }),
		}));
		await expect(embedder.embed(["a"], controller.signal)).rejects.toThrow(/aborted/);
	});
});
