import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { dirExists, fileExists } from "../core/fs.ts";

/**
 * Port of tools/viewer_launcher.py: fetches a pinned Graph Builder viewer release, patches it for
 * local pipeline mode, and copies viewer-data into it. The HTTP server lives in server.ts.
 */

export const SUBMIT_API_PATH = "/api/codebook-review/submit";
export const LOCAL_VIEWER_BOOTSTRAP = '<script>window.__GRAPH_BUILDER_VIEWER__={dataSource:"local"}</script>';

export class ViewerLaunchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ViewerLaunchError";
	}
}

export function releaseZipUrl(repo: string, version: string): string {
	const tag = version.startsWith("v") ? version : `v${version}`;
	return `https://github.com/${repo}/releases/download/${tag}/viewer-dist.zip`;
}

export function defaultCacheDir(): string {
	return join(homedir(), ".cache", "graph-builder-viewer");
}

/** Extracts a viewer-dist.zip, refusing entries that would escape the target directory. */
export async function extractViewer(zip: Uint8Array, target: string): Promise<void> {
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	const root = resolve(target);
	for (const [name, data] of Object.entries(unzipSync(zip))) {
		if (name.endsWith("/")) continue;
		const destination = resolve(root, name);
		if (!destination.startsWith(root + sep))
			throw new ViewerLaunchError(`Refusing zip entry outside target: ${name}`);
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, data);
	}
	if (await fileExists(join(target, "dist", "index.html"))) return;
	for (const child of await readdir(target)) {
		if (await fileExists(join(target, child, "dist", "index.html"))) {
			for (const item of await readdir(join(target, child))) {
				await rm(join(target, item), { recursive: true, force: true });
				await rename(join(target, child, item), join(target, item));
			}
			break;
		}
	}
	if (!(await fileExists(join(target, "dist", "index.html")))) {
		throw new ViewerLaunchError("Invalid viewer-dist.zip: missing dist/index.html");
	}
}

export type Fetcher = (url: string) => Promise<Response>;

/** Returns the cached viewer for a version, downloading it on first use. */
export async function ensureViewer(options: {
	repo: string;
	version: string;
	cacheDir?: string | undefined;
	fetch?: Fetcher;
}): Promise<string> {
	const version = options.version.replace(/^v/, "");
	const root = join(options.cacheDir ?? defaultCacheDir(), version);
	if (await fileExists(join(root, "dist", "index.html"))) return root;
	const url = releaseZipUrl(options.repo, version);
	const response = await (options.fetch ?? ((u) => fetch(u)))(url);
	if (!response.ok) {
		throw new ViewerLaunchError(
			`Failed to download viewer (${response.status}) from ${url}; check the release exists.`,
		);
	}
	await extractViewer(new Uint8Array(await response.arrayBuffer()), root);
	return root;
}

export async function patchIndexForPipelineMode(distDir: string): Promise<boolean> {
	const index = join(distDir, "index.html");
	if (!(await fileExists(index))) return false;
	const html = await readFile(index, "utf8");
	if (html.includes("__GRAPH_BUILDER_VIEWER__")) return false;
	const patched = html.includes("<head>")
		? html.replace("<head>", `<head>\n    ${LOCAL_VIEWER_BOOTSTRAP}`)
		: `${LOCAL_VIEWER_BOOTSTRAP}\n${html}`;
	await writeFile(index, patched, "utf8");
	return true;
}

/**
 * The viewer approves by downloading `<slug>-codebook_v2.json` through a small JSON download
 * helper. Its minified name changes between releases, so it is matched by structure and wrapped
 * to also POST the payload to the local server (the download still happens).
 */
const DOWNLOAD_HELPER =
	/function ([\w$]+)\(([\w$]+),([\w$]+)\)\{const ([\w$]+)=new Blob\(\[JSON\.stringify\(\3,null,2\)\],\{type:"application\/json"\}\),([\w$]+)=URL\.createObjectURL\(\4\),([\w$]+)=document\.createElement\("a"\);\6\.href=\5,\6\.download=\2,\6\.click\(\),URL\.revokeObjectURL\(\5\)\}/;

export function patchBundleSource(source: string): { source: string; patched: boolean } {
	if (source.includes(SUBMIT_API_PATH)) return { source, patched: false };
	const match = DOWNLOAD_HELPER.exec(source);
	if (!match) return { source, patched: false };
	const [whole, name, filename, payload] = match;
	const hook = `fetch("${SUBMIT_API_PATH}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:${filename},payload:${payload}})}).catch(()=>{});`;
	const body = whole.slice(whole.indexOf("{") + 1);
	// a replacer function, so `$` sequences in minified identifiers are not treated as patterns
	const patchedHelper = `function ${name}(${filename},${payload}){${hook}${body}`;
	return { source: source.replace(whole, () => patchedHelper), patched: true };
}

export async function patchBundleForPipelineSubmit(
	distDir: string,
): Promise<{ patched: number; alreadyPatched: number }> {
	const assets = join(distDir, "assets");
	if (!(await dirExists(assets))) return { patched: 0, alreadyPatched: 0 };
	let patched = 0;
	let alreadyPatched = 0;
	for (const file of (await readdir(assets)).filter((f) => /^index-.*\.js$/.test(f))) {
		const path = join(assets, file);
		const source = await readFile(path, "utf8");
		if (source.includes(SUBMIT_API_PATH)) {
			alreadyPatched++;
			continue;
		}
		const result = patchBundleSource(source);
		if (result.patched) {
			await writeFile(path, result.source, "utf8");
			patched++;
		}
	}
	return { patched, alreadyPatched };
}

/** Copies pipeline viewer-data into dist/data, which is what the static server actually serves. */
export async function syncData(dataSrc: string, distDir: string): Promise<void> {
	if (!(await fileExists(join(dataSrc, "manifest.json")))) {
		throw new ViewerLaunchError(
			`Missing ${join(dataSrc, "manifest.json")}; run the pipeline so it exports viewer-data first.`,
		);
	}
	const target = join(distDir, "data");
	await rm(target, { recursive: true, force: true });
	await cp(dataSrc, target, { recursive: true });
}

/** Same rule as `study.slug`; also rejects `.` and `..`. */
export function isSafeSlug(slug: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(slug) && slug !== "." && slug !== "..";
}

export function slugFromExportFilename(filename: string): string {
	const name = filename.split(/[\\/]/).pop() ?? filename;
	const suffix = "-codebook_v2.json";
	if (name.endsWith(suffix)) return name.slice(0, -suffix.length).trim() || "default";
	if (name === "codebook_v2.json") return "default";
	return name.replace(/\.[^.]*$/, "") || "default";
}

/** Prepares a ready-to-serve dist directory for the configured viewer version. */
export async function prepareViewer(options: {
	repo: string;
	version: string;
	dataDir: string;
	cacheDir?: string | undefined;
	fetch?: Fetcher;
}): Promise<{ distDir: string; bundlePatched: boolean }> {
	const root = await ensureViewer(options);
	const distDir = join(root, "dist");
	await patchIndexForPipelineMode(distDir);
	const { patched, alreadyPatched } = await patchBundleForPipelineSubmit(distDir);
	await syncData(options.dataDir, distDir);
	return { distDir, bundlePatched: patched + alreadyPatched > 0 };
}
