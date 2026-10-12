import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ConfigError,
	configTemplate,
	defaultConfigPath,
	loadConfig,
	resolveConfig,
	resolveDataPath,
	resolveSlug,
	resolveViewerDir,
	writeConfigTemplate,
} from "../../src/config/load.ts";

const minimal = { study: { researchQuestion: "What frustrates players?", data: "data/reviews.csv" } };

describe("resolveConfig", () => {
	it("fills every default from the original pipeline", () => {
		const config = resolveConfig(minimal);
		expect(config.seed).toBe(20260726);
		expect(config.models.coder).toBe("current");
		expect(config.openCoding).toEqual({ validator: false, maxRetries: 2, workers: 8 });
		expect(config.clustering.method).toBe("embedding");
		expect(config.clustering.nearDuplicateThreshold).toBe(0.95);
		expect(config.clustering.llm.batchSize).toBe(100);
		expect(config.labeling).toMatchObject({ strategy: "nsampling", samples: 5, sampleSize: 15 });
		expect(config.refine).toEqual({ topKOtherClusters: 5, maxCodesPerCall: 44 });
		expect(config.hierarchy.assignBatch).toBe(40);
		expect(config.hierarchy.refine).toEqual({ enabled: true, maxCodesPerBucket: 48, maxDepth: 8, llmMaxCodes: 48 });
		expect(config.evaluation.levels).toEqual(["theme_only", "theme_def", "full"]);
		expect(config.evaluation.judge.outcomes).toBe("four_way");
		expect(config.evaluation.judge.level).toBe("full");
		expect(config.review.enabled).toBe(true);
	});

	it("does not mutate the input", () => {
		const input = structuredClone(minimal);
		resolveConfig(input);
		expect(input).toEqual(minimal);
	});

	it("keeps explicit values", () => {
		const config = resolveConfig({ ...minimal, labeling: { strategy: "first30" }, models: { judges: ["a/b"] } });
		expect(config.labeling.strategy).toBe("first30");
		expect(config.labeling.samples).toBe(5);
		expect(config.models.judges).toEqual(["a/b"]);
	});

	it("rejects out-of-range values that the Python pipeline clamped", () => {
		expect(() => resolveConfig({ ...minimal, refine: { maxCodesPerCall: 200 } })).toThrow(ConfigError);
		expect(() => resolveConfig({ ...minimal, hierarchy: { assignBatch: 5 } })).toThrow(/assignBatch/);
	});

	it("rejects unknown keys and missing study fields", () => {
		expect(() => resolveConfig({ ...minimal, typo: true })).toThrow(ConfigError);
		expect(() => resolveConfig({ study: { researchQuestion: "q" } })).toThrow(/data/);
		expect(() => resolveConfig([])).toThrow("JSON object");
	});

	it("lists every issue", () => {
		try {
			resolveConfig({ study: {}, seed: "x" });
			expect.unreachable();
		} catch (error) {
			expect((error as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
		}
	});
});

describe("config files", () => {
	it("writes a template that loads back", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		const path = defaultConfigPath(dir);
		await writeConfigTemplate(path, { researchQuestion: "RQ", data: "x.csv", slug: "s1" });
		const config = await loadConfig(path);
		expect(config.study.slug).toBe("s1");
		expect(configTemplate({ researchQuestion: "RQ", data: "x.csv" })).not.toHaveProperty("study.slug");
	});

	it("explains missing and malformed files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-"));
		await expect(loadConfig(join(dir, "none.json"))).rejects.toThrow(/\/idcoder init/);
		await writeFile(join(dir, "bad.json"), "{nope", "utf8");
		await expect(loadConfig(join(dir, "bad.json"))).rejects.toThrow(/Could not parse/);
	});
});

describe("derived paths", () => {
	it("resolves data, slug, and viewer dir", () => {
		const config = resolveConfig(minimal);
		expect(resolveDataPath(config, "/proj")).toBe("/proj/data/reviews.csv");
		expect(resolveSlug(config)).toBe("reviews");
		expect(resolveViewerDir(config, "/proj")).toBe("/proj/.idcoder/viewer-data");
		const abs = resolveConfig({ study: { ...minimal.study, data: "/abs/x.csv", slug: "mine" } });
		expect(resolveDataPath(abs, "/proj")).toBe("/abs/x.csv");
		expect(resolveSlug(abs)).toBe("mine");
	});
});
