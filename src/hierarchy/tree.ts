import type { Edge, GlobalGraphFile, HierarchyFile, MetaTheme, SubTheme, TreeNode } from "../artifacts/types.ts";

export function buildSubThemeNode(st: SubTheme, parentName: string, edges: Edge[], nodes: string[]): TreeNode {
	const name = st.name || "Unnamed";
	edges.push({ parent: parentName, child: name });
	nodes.push(name);
	const node: TreeNode = { name, type: "sub_theme", children: [] };
	for (const child of st.sub_themes ?? []) {
		if (typeof child === "object" && child !== null)
			node.children!.push(buildSubThemeNode(child, name, edges, nodes));
	}
	for (const code of st.codes ?? []) {
		if (typeof code !== "string") continue;
		node.children!.push({ name: code, type: "code" });
		edges.push({ parent: name, child: code });
		nodes.push(code);
	}
	return node;
}

/** Merges meta-themes and per-cluster hierarchies into one strict tree with a flat edge list. */
export function assembleTree(
	researchQuestion: string,
	metaThemes: readonly MetaTheme[],
	hierarchy: HierarchyFile,
	codebook: Record<string, string>,
): GlobalGraphFile {
	const rootName = researchQuestion || "Thematic Analysis";
	const tree: TreeNode = { name: rootName, type: "root", children: [] };
	const edges: Edge[] = [];
	const nodes: string[] = [rootName];

	for (const mt of metaThemes) {
		const mtName = mt.name || "Unnamed Meta-Theme";
		const mtNode: TreeNode = { name: mtName, type: "meta_theme", children: [] };
		edges.push({ parent: rootName, child: mtName });
		nodes.push(mtName);
		for (const rawId of mt.cluster_ids ?? []) {
			const cid = String(rawId);
			const entry = hierarchy[cid];
			const label = entry?.label ?? codebook[cid] ?? `Cluster ${cid}`;
			const themeNode: TreeNode = { name: label, type: "theme", children: [] };
			edges.push({ parent: mtName, child: label });
			nodes.push(label);
			for (const st of entry?.sub_themes ?? []) {
				if (typeof st === "object" && st !== null)
					themeNode.children!.push(buildSubThemeNode(st, label, edges, nodes));
			}
			for (const code of entry?.ungrouped_codes ?? []) {
				themeNode.children!.push({ name: code, type: "code" });
				edges.push({ parent: label, child: code });
				nodes.push(code);
			}
			mtNode.children!.push(themeNode);
		}
		tree.children!.push(mtNode);
	}
	return {
		tree,
		canonical_nodes: [...new Set(nodes)].sort(),
		merge_groups: [],
		edges,
		inferred_edges: [],
	};
}
