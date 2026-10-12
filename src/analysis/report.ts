import type { TreeNode } from "../artifacts/types.ts";
import { isRecord } from "../core/json.ts";

const EDGES_NOTE = "\nNote: edges truncated for length; synthesis uses listed nodes and partial edges.\n";
const NODES_NOTE = "\nNote: nodes truncated for length; only a prefix of themes is included.\n";

/** Graph budget inside the report prompt for a context window (~4 chars/token, prompt overhead reserved). */
export function reportGraphMaxChars(contextTokens: number): number {
	return Math.max(4000, Math.floor(0.55 * contextTokens * 4) - 3500);
}

export function countLeaves(node: TreeNode): number {
	const children = node.children ?? [];
	if (children.length === 0) return node.type === "code" ? 1 : 0;
	return children.reduce((n, c) => n + countLeaves(c), 0);
}

export function renderTreeNode(node: TreeNode, indent = 0): string {
	const prefix = "  ".repeat(indent);
	const name = node.name ?? "Unnamed";
	if (node.type === "code") return `${prefix}* ${name}\n`;
	const children = node.children ?? [];
	const typeLabel = node.type && node.type !== "root" ? ` [${node.type}]` : "";
	const countLabel = children.length ? ` (${countLeaves(node)} codes)` : "";
	return `${prefix}- ${name}${typeLabel}${countLabel}\n${children.map((c) => renderTreeNode(c, indent + 1)).join("")}`;
}

function packLegacy(
	fileNodes: number,
	fileEdges: number,
	nodes: readonly string[],
	edges: ReadonlyArray<Record<string, unknown>>,
): string {
	const nodeLines = nodes.length ? nodes.map((n) => `- ${n}`).join("\n") : "(none)";
	const edgeLines = edges.map((e) => `  ${String(e.parent)} -> ${String(e.child)}`).join("\n");
	return [
		`graph_file_nodes: ${fileNodes}`,
		`graph_file_edges: ${fileEdges}`,
		"",
		"NODES:",
		nodeLines,
		"",
		"EDGES (parent -> child):",
		edgeLines || "(none listed)",
	].join("\n");
}

/** Compact text form of the global graph for the report LLM (tree format, or the legacy flat format). */
export function buildGraphText(graph: unknown, maxChars: number): { text: string; truncated: boolean } {
	const data = isRecord(graph) ? graph : {};
	const nodes = Array.isArray(data.canonical_nodes) ? data.canonical_nodes.map(String) : [];
	const edges = Array.isArray(data.edges) ? data.edges.filter(isRecord) : [];

	if (isRecord(data.tree)) {
		let text = `Thematic hierarchy: ${nodes.length} nodes, ${edges.length} edges (strict tree)\n\nTHEME HIERARCHY:\n`;
		text += renderTreeNode(data.tree as unknown as TreeNode);
		if (text.length > maxChars)
			return { text: `${text.slice(0, maxChars - 80)}\n...[hierarchy truncated to char limit]\n`, truncated: true };
		return { text, truncated: false };
	}

	const budget = Math.max(512, maxChars - (EDGES_NOTE.length + NODES_NOTE.length + 64));
	const keptNodes = [...nodes];
	const keptEdges = [...edges];
	while (packLegacy(nodes.length, edges.length, keptNodes, keptEdges).length > budget && keptEdges.length)
		keptEdges.pop();
	while (packLegacy(nodes.length, edges.length, keptNodes, keptEdges).length > budget && keptNodes.length)
		keptNodes.pop();
	let text = packLegacy(nodes.length, edges.length, keptNodes, keptEdges);
	const edgesCut = keptEdges.length < edges.length;
	const nodesCut = keptNodes.length < nodes.length;
	if (edgesCut) text += EDGES_NOTE;
	if (nodesCut) text += NODES_NOTE;
	if (text.length > maxChars) text = `${text.slice(0, maxChars - 80)}\n...[payload hard truncated to char limit]\n`;
	return { text, truncated: edgesCut || nodesCut };
}
