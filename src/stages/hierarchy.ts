import type { HierarchyEntry } from "../artifacts/types.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl } from "../core/fs.ts";
import { fingerprint } from "../core/hash.ts";
import { sortClusterIds } from "../core/ids.ts";
import { buildClusterHierarchy } from "../hierarchy/build.ts";
import { modelRefForRole } from "../llm/service.ts";
import { done, type Stage } from "../pipeline/stage.ts";

interface HierarchyCheckpoint {
	cluster_id: string;
	input_hash: string;
	entry: HierarchyEntry;
}

export const hierarchyStage: Stage = {
	id: "hierarchy",
	title: "Hierarchy construction",
	enabled: () => true,
	checkpoints: (paths) => [paths.hierarchyCheckpoint],
	async run(ctx) {
		const cb = await ctx.store.codebook();
		const ctc = cb.cluster_to_codes;
		const ids = sortClusterIds(Object.keys(ctc));
		if (ids.length === 0) throw new Error("No cluster_to_codes in codebook.json.");
		const labelOf = (id: string) => cb.codebook[id] ?? `Cluster ${id}`;
		const settingsKey = fingerprint(
			ctx.config.study.researchQuestion,
			ctx.config.hierarchy,
			modelRefForRole(ctx.config.models, "coder"),
		);
		const inputHash = (label: string, codes: readonly string[]) => fingerprint(settingsKey, label, codes);

		const restored = new Map<string, HierarchyCheckpoint>();
		for (const row of await readJsonl<HierarchyCheckpoint>(ctx.paths.hierarchyCheckpoint))
			restored.set(row.cluster_id, row);
		const entries = new Map<string, HierarchyEntry>();
		const pending: string[] = [];
		for (const id of ids) {
			const row = restored.get(id);
			if (row && row.input_hash === inputHash(labelOf(id), ctc[id] ?? [])) entries.set(id, row.entry);
			else pending.push(id);
		}

		let finished = entries.size;
		await mapConcurrent(
			pending,
			ctx.config.hierarchy.workers,
			async (id) => ({
				id,
				entry: await buildClusterHierarchy(id, labelOf(id), ctc[id] ?? [], {
					llm: ctx.llm,
					embedder: ctx.embedder,
					researchQuestion: ctx.config.study.researchQuestion,
					settings: ctx.config.hierarchy,
					logger: ctx.logger,
					signal: ctx.signal,
				}),
			}),
			{
				signal: ctx.signal,
				onResult: async ({ id, entry }) => {
					entries.set(id, entry);
					await appendJsonl(ctx.paths.hierarchyCheckpoint, {
						cluster_id: id,
						input_hash: inputHash(labelOf(id), ctc[id] ?? []),
						entry,
					} satisfies HierarchyCheckpoint);
					const total =
						entry.sub_themes.reduce((n, st) => n + (st.codes?.length ?? 0), 0) + entry.ungrouped_codes.length;
					ctx.logger.info(
						"HIERARCHY_CLUSTER_DONE",
						`Cluster ${id} (${entry.label}): ${entry.sub_themes.length} sub-themes, ${total} codes`,
					);
					ctx.progress({ done: ++finished, total: ids.length, message: entry.label });
				},
			},
		);

		await ctx.store.writeHierarchy(Object.fromEntries(ids.map((id) => [id, entries.get(id)!])));
		const subThemes = [...entries.values()].reduce((n, e) => n + e.sub_themes.length, 0);
		return done(`Hierarchy: ${ids.length} clusters with ${subThemes} sub-themes`, {
			clusters: ids.length,
			sub_themes: subThemes,
		});
	},
};
