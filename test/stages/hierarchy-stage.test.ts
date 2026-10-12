import { describe, expect, it } from "vitest";
import { MissingArtifactError } from "../../src/artifacts/store.ts";
import { readJsonl, writeJson } from "../../src/core/fs.ts";
import { hierarchyStage } from "../../src/stages/hierarchy.ts";
import { ScriptedLlm } from "../helpers/fake-llm.ts";
import { makeContext } from "../helpers/harness.ts";

describe("hierarchy stage", () => {
	it("reuses checkpointed clusters whose label and codes are unchanged", async () => {
		const codes = Array.from({ length: 7 }, (_, i) => `c${i}`);
		const llm = new ScriptedLlm({
			hierarchy_construction: JSON.stringify({
				sub_themes: [{ name: "S", codes: ["c0", "c1"] }],
				ungrouped_codes: [],
			}),
		});
		const ctx = await makeContext({ llm });
		await writeJson(ctx.paths.codebook, {
			codebook: { "0": "A", "1": "B" },
			cluster_to_codes: { "0": codes, "1": ["x"] },
		});
		const outcome = await hierarchyStage.run(ctx);
		expect(outcome).toMatchObject({ metrics: { clusters: 2, sub_themes: 1 } });
		expect(llm.calls).toHaveLength(1);
		expect(await readJsonl(ctx.paths.hierarchyCheckpoint)).toHaveLength(2);

		await writeJson(ctx.paths.codebook, {
			codebook: { "0": "A renamed", "1": "B" },
			cluster_to_codes: { "0": codes, "1": ["x"] },
		});
		await hierarchyStage.run(ctx);
		expect(llm.calls).toHaveLength(2);
		expect(ctx.progressUpdates.at(-1)).toMatchObject({ done: 2, total: 2 });
	});

	it("fails clearly without clusters", async () => {
		const ctx = await makeContext({ llm: new ScriptedLlm({}) });
		await expect(hierarchyStage.run(ctx)).rejects.toBeInstanceOf(MissingArtifactError);
		await writeJson(ctx.paths.codebook, { codebook: {}, cluster_to_codes: {} });
		await expect(hierarchyStage.run(ctx)).rejects.toThrow(/No cluster_to_codes/);
	});
});
