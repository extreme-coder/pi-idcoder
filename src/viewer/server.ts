import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { writeJson } from "../core/fs.ts";
import { isRecord } from "../core/json.ts";
import { codebookReviewDir } from "./data.ts";
import { isSafeSlug, SUBMIT_API_PATH, slugFromExportFilename } from "./launcher.ts";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

const MAX_BODY_BYTES = 50 * 1024 * 1024;

export interface ApprovalEvent {
	slug: string;
	path: string;
	payload: Record<string, unknown>;
}

export interface ViewerServerOptions {
	distDir: string;
	/** Pipeline viewer-data folder; approvals are written back here. */
	dataDir: string;
	port: number;
}

/**
 * Serves the patched viewer on 127.0.0.1 and receives approvals at the submit endpoint, writing
 * `codebook-reviews/<slug>/codebook_v2.json` into the pipeline data folder (and the served copy).
 */
export class ViewerServer extends EventEmitter<{ approved: [ApprovalEvent] }> {
	private readonly options: ViewerServerOptions;
	private server: Server | undefined;

	constructor(options: ViewerServerOptions) {
		super();
		this.options = options;
	}

	get url(): string {
		const address = this.server?.address() as AddressInfo | null | undefined;
		if (!address) throw new Error("Viewer server is not running");
		return `http://127.0.0.1:${address.port}/`;
	}

	get running(): boolean {
		return this.server?.listening ?? false;
	}

	async start(): Promise<string> {
		if (this.running) return this.url;
		const server = createServer((req, res) => {
			this.handle(req, res).catch((error: unknown) => {
				this.send(res, 500, { ok: false, error: (error as Error).message });
			});
		});
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, "127.0.0.1", () => {
				server.off("error", reject);
				resolveListen();
			});
		});
		this.server = server;
		return this.url;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}

	/** Resolves with the next approval for `slug`, or rejects on abort. */
	waitForApproval(slug: string, signal?: AbortSignal): Promise<ApprovalEvent> {
		return new Promise((resolveWait, reject) => {
			const onApproved = (event: ApprovalEvent) => {
				if (event.slug !== slug) return;
				cleanup();
				resolveWait(event);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Stopped waiting for browser approval"));
			};
			const cleanup = () => {
				this.off("approved", onApproved);
				signal?.removeEventListener("abort", onAbort);
			};
			if (signal?.aborted) return onAbort();
			this.on("approved", onApproved);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private send(res: ServerResponse, status: number, body: unknown): void {
		if (res.headersSent) return;
		const text = JSON.stringify(body);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
		res.end(text);
	}

	private async readBody(req: IncomingMessage): Promise<string> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
		if (req.method === "POST") {
			if (path !== SUBMIT_API_PATH) return this.send(res, 404, { ok: false, error: "Not found" });
			// Only the viewer page itself may submit: a JSON content type forces a CORS preflight for
			// other origins (never answered here), and an explicit foreign Origin is refused outright.
			const origin = req.headers.origin;
			const port = new URL(this.url).port;
			const allowed = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
			if (origin !== undefined && !allowed.includes(origin)) {
				return this.send(res, 403, { ok: false, error: "Cross-origin submissions are not allowed" });
			}
			if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
				return this.send(res, 415, { ok: false, error: "Expected application/json" });
			}
			let data: unknown;
			try {
				data = JSON.parse(await this.readBody(req));
			} catch (error) {
				return this.send(res, 400, { ok: false, error: (error as Error).message });
			}
			if (!isRecord(data) || !isRecord(data.payload)) {
				return this.send(res, 400, { ok: false, error: "payload must be a JSON object" });
			}
			const slug = slugFromExportFilename(typeof data.filename === "string" ? data.filename : "codebook_v2.json");
			if (!isSafeSlug(slug)) return this.send(res, 400, { ok: false, error: "Invalid review slug" });
			const written = join(codebookReviewDir(this.options.dataDir, slug), "codebook_v2.json");
			await writeJson(written, data.payload);
			await writeJson(
				join(codebookReviewDir(join(this.options.distDir, "data"), slug), "codebook_v2.json"),
				data.payload,
			);
			this.emit("approved", { slug, path: written, payload: data.payload });
			return this.send(res, 200, { ok: true, path: written });
		}
		if (req.method !== "GET" && req.method !== "HEAD")
			return this.send(res, 405, { ok: false, error: "Method not allowed" });

		const root = resolve(this.options.distDir);
		let file = resolve(root, `.${normalize(path)}`);
		if (file !== root && !file.startsWith(root + sep)) return this.send(res, 403, { ok: false, error: "Forbidden" });
		try {
			if ((await stat(file)).isDirectory()) file = join(file, "index.html");
		} catch {
			file = extname(path) ? file : join(root, "index.html");
		}
		let body: Buffer;
		try {
			body = await readFile(file);
		} catch {
			return this.send(res, 404, { ok: false, error: "Not found" });
		}
		res.writeHead(200, {
			"content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
			"content-length": body.length,
			"cache-control": "no-store",
		});
		res.end(req.method === "HEAD" ? undefined : body);
	}
}
