import type { IdcoderConfig } from "../config/schema.ts";
import type { ViewerHost } from "../viewer/host.ts";
import { pendingMessage, type ReviewDecision, type ReviewGateway, type ReviewRequest } from "./gateway.ts";
import type { EnrichedCodebook } from "./schema.ts";

/**
 * Review through the Graph Builder viewer: serves it locally, opens the browser, and waits until
 * the researcher clicks "Approve & export" (or the timeout passes).
 */
export class BrowserReviewGateway implements ReviewGateway {
	private readonly host: ViewerHost;
	private readonly config: IdcoderConfig;
	private readonly projectDir: string;
	private readonly openUrl: (url: string) => Promise<void>;
	private readonly notify: (message: string) => void;

	constructor(options: {
		host: ViewerHost;
		config: IdcoderConfig;
		projectDir: string;
		openUrl: (url: string) => Promise<void>;
		notify: (message: string) => void;
	}) {
		this.host = options.host;
		this.config = options.config;
		this.projectDir = options.projectDir;
		this.openUrl = options.openUrl;
		this.notify = options.notify;
	}

	async review(request: ReviewRequest): Promise<ReviewDecision> {
		const { url, server, bundlePatched } = await this.host.open(this.config, this.projectDir);
		if (!bundlePatched) {
			return {
				kind: "pending",
				message: `This viewer release could not be patched for automatic approval. Approve in ${url}, then move the downloaded ${request.slug}-codebook_v2.json into ${request.viewerDir}/codebook-reviews/${request.slug}/ and resume.`,
			};
		}
		if (this.config.viewer.openBrowser) await this.openUrl(url).catch(() => {});
		this.notify(`Codebook review is open at ${url} (Codebook review tab). Waiting for "Approve & export"…`);

		const timeout = AbortSignal.timeout(this.config.review.timeoutSec * 1000);
		const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
		try {
			const approval = await server.waitForApproval(request.slug, signal);
			return { kind: "approved", payload: approval.payload as unknown as EnrichedCodebook, reviewId: request.slug };
		} catch {
			if (request.signal?.aborted) throw request.signal.reason ?? new Error("aborted");
			return { kind: "pending", message: `No approval from the browser yet.\n${pendingMessage(request)}` };
		}
	}
}
