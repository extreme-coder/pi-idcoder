import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
/** The package root: pi reads the `pi` manifest, loading the extension and the agent skill. */
export const PACKAGE_DIR = ROOT;
export const piAvailable = existsSync(PI_CLI);

export type RpcRecord = Record<string, unknown> & { type: string };

/** Drives a real `pi --mode rpc` child process with the extension loaded. */
export class PiRpc {
	readonly records: RpcRecord[] = [];
	readonly stderr: string[] = [];
	private readonly child: ChildProcessWithoutNullStreams;
	private buffer = "";
	private waiters: Array<{ test: (r: RpcRecord) => boolean; resolve: (r: RpcRecord) => void }> = [];
	private nextId = 0;

	constructor(options: { cwd: string; agentDir: string; model: string; env?: NodeJS.ProcessEnv }) {
		this.child = spawn(
			process.execPath,
			[PI_CLI, "--mode", "rpc", "--no-session", "--offline", "-ne", "-e", PACKAGE_DIR, "--model", options.model],
			{
				cwd: options.cwd,
				// a private HOME keeps the user's own skills and settings out of the run
				env: { ...process.env, ...options.env, HOME: options.agentDir, PI_CODING_AGENT_DIR: options.agentDir },
			},
		);
		this.child.stderr.on("data", (d: Buffer) => this.stderr.push(d.toString()));
		this.child.stdout.on("data", (d: Buffer) => {
			this.buffer += d.toString();
			for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
				const line = this.buffer.slice(0, i).replace(/\r$/, "");
				this.buffer = this.buffer.slice(i + 1);
				if (!line.trim()) continue;
				const record = JSON.parse(line) as RpcRecord;
				this.records.push(record);
				this.waiters = this.waiters.filter((w) => {
					if (!w.test(record)) return true;
					w.resolve(record);
					return false;
				});
			}
		});
	}

	waitFor(test: (r: RpcRecord) => boolean, timeoutMs = 60_000): Promise<RpcRecord> {
		const existing = this.records.find(test);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`Timed out waiting for RPC record\n${this.stderr.join("")}`)),
				timeoutMs,
			);
			this.waiters.push({
				test,
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
			});
		});
	}

	/** Sends a command and resolves with its response. */
	async command(command: Record<string, unknown>, timeoutMs = 120_000): Promise<RpcRecord> {
		const id = `cmd-${++this.nextId}`;
		const response = this.waitFor((r) => r.type === "response" && r.id === id, timeoutMs);
		this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return response;
	}

	/** Runs `/idcoder …` and returns the custom message it posted. */
	async idcoder(args: string, timeoutMs = 120_000): Promise<string> {
		const before = this.records.length;
		const response = await this.command({ type: "prompt", message: `/idcoder ${args}` }, timeoutMs);
		if (response.success !== true) throw new Error(`prompt failed: ${JSON.stringify(response)}`);
		const message = this.records
			.slice(before)
			.find((r) => r.type === "message_end" && (r.message as { customType?: string })?.customType === "idcoder");
		return String((message?.message as { content?: unknown } | undefined)?.content ?? "");
	}

	notifications(): string[] {
		return this.records
			.filter((r) => r.type === "extension_ui_request" && r.method === "notify")
			.map((r) => String(r.message));
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.child.kill("SIGKILL");
				resolve();
			}, 10_000);
			this.child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}
