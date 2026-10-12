import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HashingEmbedder } from "./fake-embedder.ts";
import { inferSkill, simulate } from "./simulated-llm.ts";

export interface RecordedRequest {
	path: string;
	body: Record<string, unknown>;
	skill?: string;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part === "object" && part && "text" in part ? String(part.text) : ""))
			.join("");
	}
	return "";
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * OpenAI-compatible server for offline integration tests: chat completions (streamed or not)
 * answered by the pipeline simulator, and embeddings from the hashing embedder.
 */
export class MockOpenAI {
	readonly requests: RecordedRequest[] = [];
	private server: Server | undefined;
	private readonly embedder = new HashingEmbedder(64);

	get baseUrl(): string {
		const address = this.server!.address() as AddressInfo;
		return `http://127.0.0.1:${address.port}/v1`;
	}

	async start(): Promise<string> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((error: unknown) => {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: (error as Error).message } }));
			});
		});
		await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
		return this.baseUrl;
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
		const path = (req.url ?? "").split("?")[0]!;
		if (req.method === "GET" && path.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "sim", object: "model" }] }));
			return;
		}
		const body = await readBody(req);
		if (path.endsWith("/embeddings")) {
			this.requests.push({ path, body });
			const input = Array.isArray(body.input) ? body.input.map(String) : [String(body.input)];
			const m = await this.embedder.embed(input);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					object: "list",
					data: input.map((_, i) => ({ object: "embedding", index: i, embedding: Array.from(m.row(i)) })),
					usage: { prompt_tokens: input.length, total_tokens: input.length },
				}),
			);
			return;
		}
		if (!path.endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role: string; content: unknown }>) : [];
		const system = messages
			.filter((m) => m.role === "system" || m.role === "developer")
			.map((m) => messageText(m.content))
			.join("\n");
		const prompt = messageText(messages.filter((m) => m.role === "user").at(-1)?.content);
		const skill = inferSkill(system, prompt);
		this.requests.push({ path, body, skill });
		const text = simulate({ skill, prompt });
		const usage = {
			prompt_tokens: Math.ceil(prompt.length / 4),
			completion_tokens: Math.ceil(text.length / 4),
			total_tokens: 0,
		};
		usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

		if (!body.stream) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl-mock",
					object: "chat.completion",
					model: body.model,
					choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
					usage,
				}),
			);
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const chunk = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
			`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
		res.write(chunk({ role: "assistant", content: "" }, null));
		for (let i = 0; i < text.length; i += 200) res.write(chunk({ content: text.slice(i, i + 200) }, null));
		res.write(chunk({}, "stop", { usage }));
		res.end("data: [DONE]\n\n");
	}
}
