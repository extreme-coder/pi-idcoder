import { copyFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { RunPaths } from "../artifacts/paths.ts";
import { ensureDir, fileExists, readJsonIfExists, writeJson } from "../core/fs.ts";

/**
 * Some stages rewrite shared artifacts in place (review materialization, refinement, enrichment,
 * hierarchy refinement). Before a stage first runs, the runner snapshots those files so that a
 * retry or an explicit `from` starts from exactly the inputs the stage originally saw.
 */

export function mutableArtifacts(paths: RunPaths): string[] {
	return [paths.codebook, paths.codebookConfidence, paths.clusteredCodes, paths.hierarchy, paths.codebookProvenance];
}

function snapshotDir(paths: RunPaths, stage: string): string {
	return join(paths.root, "snapshots", stage);
}

interface SnapshotManifest {
	present: string[];
}

export async function hasSnapshot(paths: RunPaths, stage: string): Promise<boolean> {
	return fileExists(join(snapshotDir(paths, stage), "manifest.json"));
}

export async function takeSnapshot(paths: RunPaths, stage: string): Promise<void> {
	const dir = snapshotDir(paths, stage);
	await rm(dir, { recursive: true, force: true });
	await ensureDir(dir);
	const present: string[] = [];
	for (const file of mutableArtifacts(paths)) {
		if (!(await fileExists(file))) continue;
		await copyFile(file, join(dir, basename(file)));
		present.push(basename(file));
	}
	await writeJson(join(dir, "manifest.json"), { present } satisfies SnapshotManifest);
}

/** Puts every mutable artifact back as it was when the snapshot was taken (absent files are removed). */
export async function restoreSnapshot(paths: RunPaths, stage: string): Promise<boolean> {
	const dir = snapshotDir(paths, stage);
	const manifest = await readJsonIfExists<SnapshotManifest>(join(dir, "manifest.json"));
	if (!manifest) return false;
	for (const file of mutableArtifacts(paths)) {
		const name = basename(file);
		if (manifest.present.includes(name)) await copyFile(join(dir, name), file);
		else await rm(file, { force: true });
	}
	return true;
}

export async function deleteSnapshot(paths: RunPaths, stage: string): Promise<void> {
	await rm(snapshotDir(paths, stage), { recursive: true, force: true });
}
