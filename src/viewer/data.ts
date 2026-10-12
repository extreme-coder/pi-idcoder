import { copyFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RunPaths } from "../artifacts/paths.ts";
import type { GlobalGraphFile } from "../artifacts/types.ts";
import { ensureDir, fileExists, readJson, readJsonIfExists, readText, writeJson } from "../core/fs.ts";
import { isRecord } from "../core/json.ts";
import type { CodeEvidenceFile } from "../evidence/code-evidence.ts";

/**
 * The `viewer-data/` folder read by the Graph Builder viewer:
 *   manifest.json, projects/<slug>/..., codebook-reviews/<slug>/...
 */

export interface ViewerManifest {
	projects: string[];
	codebook_reviews: string[];
}

export class ViewerExportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ViewerExportError";
	}
}

export function codebookReviewDir(root: string, slug: string): string {
	return join(root, "codebook-reviews", slug);
}

export function projectDir(root: string, slug: string): string {
	return join(root, "projects", slug);
}

export async function ensureViewerScaffold(root: string): Promise<string> {
	await ensureDir(join(root, "projects"));
	await ensureDir(join(root, "codebook-reviews"));
	if (!(await fileExists(join(root, "manifest.json")))) {
		await writeJson(join(root, "manifest.json"), { projects: [], codebook_reviews: [] });
	}
	return root;
}

export async function readManifest(root: string): Promise<ViewerManifest> {
	await ensureViewerScaffold(root);
	let data: unknown;
	try {
		data = await readJson(join(root, "manifest.json"));
	} catch {
		data = {};
	}
	const record = isRecord(data) ? data : {};
	const list = (value: unknown) =>
		Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	return { projects: list(record.projects), codebook_reviews: list(record.codebook_reviews) };
}

async function addToManifest(root: string, key: keyof ViewerManifest, slug: string): Promise<void> {
	const manifest = await readManifest(root);
	if (!manifest[key].includes(slug)) manifest[key].push(slug);
	await writeJson(join(root, "manifest.json"), manifest);
}

function meta(slug: string, researchQuestion: string): Record<string, string> {
	const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
	return {
		id: slug,
		slug,
		created_at: now,
		updated_at: now,
		...(researchQuestion ? { research_question: researchQuestion } : {}),
	};
}

async function copyIfExists(src: string, dst: string): Promise<boolean> {
	if (!(await fileExists(src))) return false;
	await copyFile(src, dst);
	return true;
}

export function researchQuestionFromReport(markdown: string): string {
	const marker = "## Research question";
	const index = markdown.indexOf(marker);
	if (index === -1) return "";
	for (const line of markdown.slice(index + marker.length).split("\n")) {
		const s = line.trim();
		if (!s) continue;
		if (s.length >= 2 && s[0] === s.at(-1) && (s[0] === '"' || s[0] === "'")) return s.slice(1, -1).trim();
		return s;
	}
	return "";
}

/** Prefers the configured question, then the report's restatement, then the graph root name. */
export async function resolveResearchQuestion(paths: RunPaths, explicit = ""): Promise<string> {
	if (explicit.trim()) return explicit.trim();
	if (await fileExists(paths.researchReport)) {
		const fromReport = researchQuestionFromReport(await readText(paths.researchReport));
		if (fromReport) return fromReport;
	}
	const graph = await readJsonIfExists<GlobalGraphFile>(paths.globalGraph).catch(() => undefined);
	return graph?.tree?.name?.trim() ?? "";
}

export async function exportCodebookReview(options: {
	root: string;
	slug: string;
	researchQuestion: string;
	paths: RunPaths;
	evidence?: CodeEvidenceFile | undefined;
}): Promise<string> {
	const { root, slug, paths } = options;
	await ensureViewerScaffold(root);
	const dir = codebookReviewDir(root, slug);
	await ensureDir(dir);
	const missing: string[] = [];
	if (!(await copyIfExists(paths.codebook, join(dir, "codebook.json")))) missing.push("codebook");
	if (!(await copyIfExists(paths.clusteredCodes, join(dir, "gt_clustered_codes.json"))))
		missing.push("clustered codes");
	await copyIfExists(paths.codebookConfidence, join(dir, "codebook_confidence.json"));
	if (missing.length) throw new ViewerExportError(`viewer export missing required artifacts: ${missing.join(", ")}`);
	if (options.evidence) await writeJson(join(dir, "code_evidence.json"), options.evidence);
	await writeJson(join(dir, "meta.json"), meta(slug, await resolveResearchQuestion(paths, options.researchQuestion)));
	await addToManifest(root, "codebook_reviews", slug);
	return dir;
}

export async function exportProject(options: {
	root: string;
	slug: string;
	researchQuestion: string;
	paths: RunPaths;
}): Promise<string> {
	const { root, slug, paths } = options;
	await ensureViewerScaffold(root);
	const dir = projectDir(root, slug);
	await ensureDir(dir);
	const missing: string[] = [];
	if (!(await copyIfExists(paths.globalGraph, join(dir, "gt_global_graph.json")))) missing.push("global graph");
	if (!(await copyIfExists(paths.researchReport, join(dir, "research_report.md")))) missing.push("research report");
	await copyIfExists(paths.openCodesMarkdown, join(dir, "gt_open_codes_all_reviews.md"));
	await copyIfExists(paths.cooccurrence, join(dir, "cooccurrence.json"));
	if (missing.length) throw new ViewerExportError(`viewer export missing required artifacts: ${missing.join(", ")}`);
	await writeJson(join(dir, "meta.json"), meta(slug, await resolveResearchQuestion(paths, options.researchQuestion)));
	await addToManifest(root, "projects", slug);
	return dir;
}

/** Removes approvals left from an earlier review so a fresh proposal cannot be auto-approved by them. */
export async function clearViewerApprovals(root: string, slug: string): Promise<void> {
	const dir = codebookReviewDir(root, slug);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (name === "codebook_v2.json" || name.endsWith("-codebook_v2.json")) await rm(join(dir, name), { force: true });
	}
}

/** The approved review dropped by the viewer: canonical name first, else the newest `*-codebook_v2.json`. */
export async function findViewerApproval(root: string, slug: string): Promise<string | undefined> {
	const dir = codebookReviewDir(root, slug);
	const canonical = join(dir, "codebook_v2.json");
	if (await fileExists(canonical)) return canonical;
	try {
		const matches = (await readdir(dir)).filter((name) => name.endsWith("-codebook_v2.json")).sort();
		return matches.length ? join(dir, matches.at(-1)!) : undefined;
	} catch {
		return undefined;
	}
}
