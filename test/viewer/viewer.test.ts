import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { RunPaths } from "../../src/artifacts/paths.ts";
import { fileExists, readJson, writeJson } from "../../src/core/fs.ts";
import { BrowserReviewGateway } from "../../src/review/browser-gateway.ts";
import { buildV1 } from "../../src/review/schema.ts";
import { ensureViewerScaffold } from "../../src/viewer/data.ts";
import { ViewerHost } from "../../src/viewer/host.ts";
import {
	ensureViewer,
	extractViewer,
	LOCAL_VIEWER_BOOTSTRAP,
	patchBundleSource,
	patchIndexForPipelineMode,
	prepareViewer,
	releaseZipUrl,
	SUBMIT_API_PATH,
	slugFromExportFilename,
	ViewerLaunchError,
} from "../../src/viewer/launcher.ts";
import { ViewerServer } from "../../src/viewer/server.ts";
import { testConfig } from "../helpers/harness.ts";

/** Same shape as the helper in the real v0.2.4 (`Cue`) and v0.2.8 (`wue`) bundles. */
const HELPER = (name: string) =>
	`function ${name}(n,e){const t=new Blob([JSON.stringify(e,null,2)],{type:"application/json"}),i=URL.createObjectURL(t),r=document.createElement("a");r.href=i,r.download=n,r.click(),URL.revokeObjectURL(i)}`;

function viewerZip(prefix = ""): Uint8Array {
	return zipSync({
		[`${prefix}dist/index.html`]: strToU8("<html><head><title>v</title></head><body></body></html>"),
		[`${prefix}dist/assets/index-abc.js`]: strToU8(`var a=1;${HELPER("wue")};wue("x-codebook_v2.json",{})`),
		[`${prefix}dist/assets/vendor.js`]: strToU8("ignored"),
		[`${prefix}README.txt`]: strToU8("viewer"),
	});
}

const zipFetch =
	(zip: Uint8Array, calls: string[] = []) =>
	async (url: string) => {
		calls.push(url);
		return new Response(new Blob([zip as Uint8Array<ArrayBuffer>]), { status: 200 });
	};

/** Sends the path verbatim (fetch would normalize dot segments before the server sees them). */
function rawGet(base: string, path: string): Promise<number> {
	const { hostname, port } = new URL(base);
	return new Promise((resolve, reject) => {
		request({ hostname, port, path, method: "GET" }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		})
			.on("error", reject)
			.end();
	});
}

const servers: ViewerServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("viewer launcher", () => {
	it("builds release URLs and slugs from export names", () => {
		expect(releaseZipUrl("o/r", "0.2.8")).toBe("https://github.com/o/r/releases/download/v0.2.8/viewer-dist.zip");
		expect(releaseZipUrl("o/r", "v1")).toBe("https://github.com/o/r/releases/download/v1/viewer-dist.zip");
		expect(slugFromExportFilename("my-study-codebook_v2.json")).toBe("my-study");
		expect(slugFromExportFilename("dir/codebook_v2.json")).toBe("default");
		expect(slugFromExportFilename("other.json")).toBe("other");
		expect(slugFromExportFilename("-codebook_v2.json")).toBe("default");
	});

	it("patches the JSON download helper whatever its minified name", () => {
		for (const name of ["Cue", "wue", "$a"]) {
			const { source, patched } = patchBundleSource(`x;${HELPER(name)};y`);
			expect(patched).toBe(true);
			expect(source).toContain(`function ${name}(n,e){fetch("${SUBMIT_API_PATH}"`);
			expect(source).toContain("body:JSON.stringify({filename:n,payload:e})");
			expect(source).toContain("r.download=n,r.click()");
			expect(patchBundleSource(source)).toEqual({ source, patched: false });
		}
		expect(patchBundleSource("nothing here").patched).toBe(false);
	});

	it("extracts, flattens nested archives, and rejects path traversal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-v-"));
		await extractViewer(viewerZip("viewer-0.2.8/"), join(dir, "a"));
		expect(await fileExists(join(dir, "a", "dist", "index.html"))).toBe(true);
		await expect(extractViewer(zipSync({ "../evil.txt": strToU8("x") }), join(dir, "b"))).rejects.toThrow(
			/outside target/,
		);
		await expect(extractViewer(zipSync({ "x.txt": strToU8("x") }), join(dir, "c"))).rejects.toThrow(
			/missing dist\/index.html/,
		);
	});

	it("caches downloads per version and reports HTTP failures", async () => {
		const cacheDir = await mkdtemp(join(tmpdir(), "idc-v-"));
		const calls: string[] = [];
		await ensureViewer({ repo: "o/r", version: "1.0.0", cacheDir, fetch: zipFetch(viewerZip(), calls) });
		await ensureViewer({ repo: "o/r", version: "v1.0.0", cacheDir, fetch: zipFetch(viewerZip(), calls) });
		expect(calls).toHaveLength(1);
		await expect(
			ensureViewer({ repo: "o/r", version: "9", cacheDir, fetch: async () => new Response("no", { status: 404 }) }),
		).rejects.toThrow(ViewerLaunchError);
	});

	it("injects the local-mode bootstrap once", async () => {
		const dir = await mkdtemp(join(tmpdir(), "idc-v-"));
		await writeFile(join(dir, "index.html"), "<html><head></head></html>");
		expect(await patchIndexForPipelineMode(dir)).toBe(true);
		expect(await patchIndexForPipelineMode(dir)).toBe(false);
		expect(await readFile(join(dir, "index.html"), "utf8")).toContain(LOCAL_VIEWER_BOOTSTRAP);
		expect(await patchIndexForPipelineMode(join(dir, "missing"))).toBe(false);
	});

	it("prepares a dist dir with patched bundle and synced data", async () => {
		const root = await mkdtemp(join(tmpdir(), "idc-v-"));
		const dataDir = join(root, "viewer-data");
		await expect(
			prepareViewer({
				repo: "o/r",
				version: "1",
				dataDir,
				cacheDir: join(root, "cache"),
				fetch: zipFetch(viewerZip()),
			}),
		).rejects.toThrow(/manifest/);
		await ensureViewerScaffold(dataDir);
		const { distDir, bundlePatched } = await prepareViewer({
			repo: "o/r",
			version: "1",
			dataDir,
			cacheDir: join(root, "cache"),
			fetch: zipFetch(viewerZip()),
		});
		expect(bundlePatched).toBe(true);
		expect(await fileExists(join(distDir, "data", "manifest.json"))).toBe(true);
	});
});

describe("viewer server", () => {
	async function served() {
		const root = await mkdtemp(join(tmpdir(), "idc-v-"));
		const dataDir = join(root, "viewer-data");
		await ensureViewerScaffold(dataDir);
		const { distDir } = await prepareViewer({
			repo: "o/r",
			version: "1",
			dataDir,
			cacheDir: join(root, "cache"),
			fetch: zipFetch(viewerZip()),
		});
		await writeFile(join(root, "cache", "secret.txt"), "top secret");
		const server = new ViewerServer({ distDir, dataDir, port: 0 });
		servers.push(server);
		const url = await server.start();
		return { server, url, dataDir, distDir };
	}

	it("serves static files with SPA fallback and blocks traversal", async () => {
		const { url } = await served();
		const index = await fetch(url);
		expect(index.headers.get("content-type")).toContain("text/html");
		expect(await index.text()).toContain("__GRAPH_BUILDER_VIEWER__");
		expect((await fetch(`${url}data/manifest.json`)).status).toBe(200);
		expect(await (await fetch(`${url}library/some-route`)).text()).toContain("<html>");
		expect((await fetch(`${url}assets/missing.js`)).status).toBe(404);
		expect(await rawGet(url, "/../../secret.txt")).toBe(404);
		expect(await rawGet(url, "/assets/..%2F..%2F..%2Fsecret.txt")).toBe(404);
		expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
	});

	it("saves approvals into the pipeline data dir and notifies waiters", async () => {
		const { server, url, dataDir } = await served();
		const waiting = server.waitForApproval("study");
		const response = await fetch(new URL(SUBMIT_API_PATH, url), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ filename: "study-codebook_v2.json", payload: { version: 2 } }),
		});
		expect(await response.json()).toMatchObject({ ok: true });
		const event = await waiting;
		expect(event.payload).toEqual({ version: 2 });
		expect(await readJson(join(dataDir, "codebook-reviews", "study", "codebook_v2.json"))).toEqual({ version: 2 });
	});

	it("rejects malformed submissions and unknown endpoints", async () => {
		const { url } = await served();
		const post = (path: string, body: string) => fetch(new URL(path, url), { method: "POST", body });
		expect((await post(SUBMIT_API_PATH, "{bad")).status).toBe(400);
		expect((await post(SUBMIT_API_PATH, '{"payload": []}')).status).toBe(400);
		expect((await post("/api/other", "{}")).status).toBe(404);
	});

	it("stops waiting on abort and restarts idempotently", async () => {
		const { server } = await served();
		const controller = new AbortController();
		const waiting = server.waitForApproval("x", controller.signal);
		controller.abort();
		await expect(waiting).rejects.toThrow(/Stopped waiting/);
		expect(await server.start()).toBe(server.url);
		await server.stop();
		await server.stop();
		expect(server.running).toBe(false);
		expect(() => server.url).toThrow(/not running/);
	});
});

describe("browser review gateway", () => {
	it("opens the viewer and returns the researcher's approval", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "idc-v-"));
		const config = testConfig({ viewer: { port: 0, cacheDir: join(projectDir, "cache") } });
		const host = new ViewerHost({ fetch: zipFetch(viewerZip()) });
		const opened: string[] = [];
		const notes: string[] = [];
		const gateway = new BrowserReviewGateway({
			host,
			config,
			projectDir,
			openUrl: async (url) => {
				opened.push(url);
				setTimeout(() => {
					void fetch(new URL(SUBMIT_API_PATH, url), {
						method: "POST",
						body: JSON.stringify({
							filename: "test-codebook_v2.json",
							payload: { version: 2, clusters: {}, operations: [], cluster_to_codes: {} },
						}),
					});
				}, 20);
			},
			notify: (m) => notes.push(m),
		});
		const paths = new RunPaths(join(projectDir, "run"));
		const decision = await gateway.review({
			slug: "test",
			researchQuestion: "rq",
			paths,
			viewerDir: join(projectDir, ".idcoder/viewer-data"),
			proposal: buildV1({}, {}),
		});
		expect(decision.kind).toBe("approved");
		expect(opened).toHaveLength(1);
		expect(notes[0]).toContain("Approve & export");
		expect(host.url).toBe(opened[0]);
		await host.stop();
		expect(host.url).toBeUndefined();
	});

	it("falls back to manual instructions when the bundle cannot be patched", async () => {
		const projectDir = await mkdtemp(join(tmpdir(), "idc-v-"));
		const zip = zipSync({
			"dist/index.html": strToU8("<html><head></head></html>"),
			"dist/assets/index-x.js": strToU8("no helper"),
		});
		const host = new ViewerHost({ fetch: zipFetch(zip) });
		const gateway = new BrowserReviewGateway({
			host,
			config: testConfig({ viewer: { port: 0, cacheDir: join(projectDir, "cache") } }),
			projectDir,
			openUrl: async () => {},
			notify: () => {},
		});
		const decision = await gateway.review({
			slug: "s",
			researchQuestion: "",
			paths: new RunPaths(join(projectDir, "run")),
			viewerDir: join(projectDir, ".idcoder/viewer-data"),
			proposal: buildV1({}, {}),
		});
		expect(decision).toMatchObject({ kind: "pending" });
		expect(decision.kind === "pending" && decision.message).toContain("could not be patched");
		await host.stop();
	});
});

describe("against the real viewer releases", () => {
	it.skipIf(!process.env.IDCODER_NETWORK)("patches the published v0.2.4 and v0.2.8 bundles", async () => {
		const root = await mkdtemp(join(tmpdir(), "idc-net-"));
		for (const version of ["0.2.4", "0.2.8"]) {
			const dataDir = join(root, version, "viewer-data");
			await ensureViewerScaffold(dataDir);
			await writeJson(join(dataDir, "manifest.json"), { projects: [], codebook_reviews: [] });
			const { bundlePatched } = await prepareViewer({
				repo: "nimamot/Agentic_Ta_viz",
				version,
				dataDir,
				cacheDir: join(root, "cache"),
			});
			expect(bundlePatched, version).toBe(true);
		}
	});
});
