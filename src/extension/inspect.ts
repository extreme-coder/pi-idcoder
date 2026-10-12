import { readFile } from "node:fs/promises";
import type {
	CodebookConfidenceFile,
	CodebookFile,
	DimensionsEnrichedFile,
	EnrichedEntry,
	MetaThemesFile,
} from "../artifacts/types.ts";
import { fileExists, readJsonIfExists } from "../core/fs.ts";
import { sortClusterIds } from "../core/ids.ts";
import { isRecord } from "../core/json.ts";
import { EvalPaths } from "../evaluation/types.ts";
import { summarizeUsage } from "../llm/usage.ts";
import type { RunSession } from "../pipeline/session.ts";

export const INSPECT_TARGETS = [
	"codebook",
	"cluster",
	"meta_themes",
	"report",
	"evaluation",
	"usage",
	"trace",
] as const;
export type InspectTarget = (typeof INSPECT_TARGETS)[number];

export function truncateText(text: string, maxChars: number, source: string): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} characters; full content in ${source}]`;
}

function quoteOf(example: unknown): string {
	return isRecord(example) ? String(example.quote ?? "") : String(example);
}

function entryText(entry: EnrichedEntry, indent = ""): string[] {
	const lines: string[] = [];
	if (entry.definition) lines.push(`${indent}Definition: ${entry.definition}`);
	if (entry.keywords.length) lines.push(`${indent}Keywords: ${entry.keywords.join(", ")}`);
	for (const [name, list] of [
		["Include", entry.inclusion],
		["Exclude", entry.exclusion],
	] as const) {
		for (const c of list) {
			lines.push(`${indent}${name}: ${c.criterion}`);
			for (const ex of c.examples ?? []) lines.push(`${indent}  e.g. "${quoteOf(ex)}"`);
		}
	}
	return lines;
}

async function codebookOverview(session: RunSession): Promise<string> {
	const cb = await readJsonIfExists<CodebookFile>(session.paths.codebook);
	if (!cb) return "No codebook yet; the pipeline has not reached cluster labeling.";
	const confidence = (await readJsonIfExists<CodebookConfidenceFile>(session.paths.codebookConfidence)) ?? {};
	const lines = [`Codebook (${Object.keys(cb.codebook).length} clusters):`];
	for (const id of sortClusterIds(Object.keys(cb.codebook))) {
		const conf = confidence[id];
		const flags = [
			conf ? `confidence ${conf.confidence}/5` : "",
			conf?.source && conf.source !== "llm" ? conf.source : "",
			conf?.needs_more_evidence ? "needs evidence" : "",
		]
			.filter(Boolean)
			.join(", ");
		lines.push(
			`- [${id}] ${cb.codebook[id]} — ${cb.cluster_to_codes[id]?.length ?? 0} codes${flags ? ` (${flags})` : ""}`,
		);
		const definition = cb.codebook_enriched?.[id]?.definition;
		if (definition) lines.push(`    ${definition}`);
	}
	return lines.join("\n");
}

async function clusterDetail(session: RunSession, clusterId: string | undefined): Promise<string> {
	const cb = await readJsonIfExists<CodebookFile>(session.paths.codebook);
	if (!cb) return "No codebook yet.";
	if (clusterId === undefined || !(clusterId in cb.codebook)) {
		return `Pass cluster_id; available: ${sortClusterIds(Object.keys(cb.codebook)).join(", ")}.`;
	}
	const lines = [`Cluster ${clusterId}: ${cb.codebook[clusterId]}`];
	const enriched = cb.codebook_enriched?.[clusterId];
	if (enriched) lines.push(...entryText(enriched, "  "));
	lines.push("Codes:", ...(cb.cluster_to_codes[clusterId] ?? []).map((c) => `  - ${c}`));
	return lines.join("\n");
}

async function metaThemesDetail(session: RunSession): Promise<string> {
	const cb = await readJsonIfExists<CodebookFile>(session.paths.codebook);
	const clusters = (ids: readonly string[] | undefined) =>
		`Clusters: ${(ids ?? []).map((id) => cb?.codebook[String(id)] ?? `Cluster ${id}`).join("; ")}`;
	const dims = await readJsonIfExists<DimensionsEnrichedFile>(
		session.store.dimensionsPath(session.config.enrichment.dimensionEvidence),
	);
	if (dims) {
		return dims.meta_themes_enriched
			.map((mt) => [`## ${mt.label}`, ...entryText(mt), clusters(mt.cluster_ids)].join("\n"))
			.join("\n\n");
	}
	const metas = await readJsonIfExists<MetaThemesFile>(session.paths.metaThemes);
	if (!metas) return "No meta-themes yet.";
	return metas.meta_themes.map((m) => `## ${m.name}\n${clusters(m.cluster_ids)}`).join("\n\n");
}

async function readOr(path: string, missing: string): Promise<string> {
	return (await fileExists(path)) ? readFile(path, "utf8") : missing;
}

/** Read-only views of a run for the agent, so it can answer questions without opening raw files. */
export async function inspectRun(
	session: RunSession,
	target: InspectTarget,
	options: { clusterId?: string; maxChars: number },
): Promise<string> {
	const eval_ = new EvalPaths(session.paths.evaluation);
	let text: string;
	let source: string;
	switch (target) {
		case "codebook":
			[text, source] = [await codebookOverview(session), session.paths.codebook];
			break;
		case "cluster":
			[text, source] = [await clusterDetail(session, options.clusterId), session.paths.codebook];
			break;
		case "meta_themes":
			[text, source] = [await metaThemesDetail(session), session.paths.metaThemesEnriched];
			break;
		case "report":
			[text, source] = [
				await readOr(session.paths.researchReport, "No research report yet."),
				session.paths.researchReport,
			];
			break;
		case "evaluation":
			[text, source] = [
				await readOr(eval_.summaryMarkdown, "No evaluation summary yet; run idcoder_evaluate."),
				eval_.summaryMarkdown,
			];
			break;
		case "usage":
			[text, source] = [await summarizeUsage(session.paths.usage), session.paths.usage];
			break;
		case "trace": {
			const trace = await readOr(session.paths.trace, "No trace log yet.");
			[text, source] = [
				trace.length > options.maxChars ? `…${trace.slice(-options.maxChars)}` : trace,
				session.paths.trace,
			];
			break;
		}
	}
	return truncateText(text, options.maxChars, source);
}
