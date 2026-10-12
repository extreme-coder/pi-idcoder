import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir } from "./fs.ts";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
	time: string;
	level: LogLevel;
	event: string;
	detail: string;
}

export type LogListener = (entry: LogEntry) => void;

export interface Logger {
	info(event: string, detail?: string): void;
	warn(event: string, detail?: string): void;
	error(event: string, detail?: string): void;
	/** Resolves once every queued write has reached disk. */
	flush(): Promise<void>;
}

/** Appends `[HH:MM:SS] === EVENT ===` blocks to the run trace log, matching the original pipeline format. */
export class TraceLogger implements Logger {
	private readonly listeners = new Set<LogListener>();
	private queue: Promise<void> = Promise.resolve();
	private readonly path: string | undefined;

	constructor(path: string | undefined) {
		this.path = path;
	}

	subscribe(listener: LogListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	info(event: string, detail = ""): void {
		this.write("info", event, detail);
	}

	warn(event: string, detail = ""): void {
		this.write("warn", event, detail);
	}

	error(event: string, detail = ""): void {
		this.write("error", event, detail);
	}

	flush(): Promise<void> {
		return this.queue;
	}

	private write(level: LogLevel, event: string, detail: string): void {
		const now = new Date();
		const entry: LogEntry = { time: now.toISOString(), level, event, detail };
		for (const listener of this.listeners) listener(entry);
		const path = this.path;
		if (!path) return;
		const clock = now.toTimeString().slice(0, 8);
		const block = `\n[${clock}] === ${event} ===\n${detail}\n${"=".repeat(30)}`;
		this.queue = this.queue
			.then(async () => {
				await ensureDir(dirname(path));
				await appendFile(path, block, "utf8");
			})
			.catch(() => {
				// tracing must never take down a run
			});
	}
}

export const silentLogger: Logger = {
	info() {},
	warn() {},
	error() {},
	flush: () => Promise.resolve(),
};
