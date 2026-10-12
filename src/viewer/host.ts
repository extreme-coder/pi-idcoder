import { resolveViewerDir } from "../config/load.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { ensureViewerScaffold } from "./data.ts";
import { type Fetcher, prepareViewer } from "./launcher.ts";
import { ViewerServer } from "./server.ts";

export interface OpenedViewer {
	url: string;
	server: ViewerServer;
	bundlePatched: boolean;
}

/** One viewer server per pi session; data is re-synced every time it is opened. */
export class ViewerHost {
	private server: ViewerServer | undefined;
	private serverKey = "";
	private readonly fetch: Fetcher | undefined;

	constructor(options: { fetch?: Fetcher } = {}) {
		this.fetch = options.fetch;
	}

	async open(config: IdcoderConfig, projectDir: string): Promise<OpenedViewer> {
		const dataDir = resolveViewerDir(config, projectDir);
		await ensureViewerScaffold(dataDir);
		const { distDir, bundlePatched } = await prepareViewer({
			repo: config.viewer.repo,
			version: config.viewer.version,
			dataDir,
			cacheDir: config.viewer.cacheDir,
			...(this.fetch ? { fetch: this.fetch } : {}),
		});
		const key = JSON.stringify([distDir, dataDir, config.viewer.port]);
		if (!this.server || this.serverKey !== key) {
			await this.server?.stop();
			this.server = new ViewerServer({ distDir, dataDir, port: config.viewer.port });
			this.serverKey = key;
		}
		const url = await this.server.start();
		return { url, server: this.server, bundlePatched };
	}

	get url(): string | undefined {
		return this.server?.running ? this.server.url : undefined;
	}

	async stop(): Promise<void> {
		await this.server?.stop();
		this.server = undefined;
	}
}
