import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type AnyTool = {
	name: string;
	parameters: unknown;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<unknown>;
};
type AnyCommand = {
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void>;
};

export interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	usage?: { totalTokens: number };
	isError?: boolean;
	terminate?: boolean;
}

/** Records what the extension registers and lets tests call tools and commands directly. */
export class FakePi {
	readonly tools = new Map<string, AnyTool>();
	readonly commands = new Map<string, AnyCommand>();
	readonly flags = new Map<string, unknown>();
	readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	readonly messages: Array<{ customType: string; content: string; details?: unknown }> = [];
	readonly execs: Array<[string, string[]]> = [];
	flagValues: Record<string, string | boolean> = {};

	asApi(): ExtensionAPI {
		const api = {
			registerTool: (tool: AnyTool) => void this.tools.set(tool.name, tool),
			registerCommand: (name: string, command: AnyCommand) => void this.commands.set(name, command),
			registerFlag: (name: string, options: unknown) => void this.flags.set(name, options),
			getFlag: (name: string) => this.flagValues[name],
			on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
				this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
				return () => {};
			},
			sendMessage: (message: { customType: string; content: string; details?: unknown }) =>
				void this.messages.push(message),
			exec: async (command: string, args: string[]) => {
				this.execs.push([command, args]);
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		};
		return api as unknown as ExtensionAPI;
	}

	async tool(
		name: string,
		params: unknown,
		ctx: unknown,
		onUpdate?: (u: unknown) => void,
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`No tool ${name}`);
		return (await tool.execute("call-1", params, signal, onUpdate, ctx)) as ToolResult;
	}

	async command(args: string, ctx: unknown): Promise<void> {
		await this.commands.get("idcoder")!.handler(args, ctx);
	}

	async emit(event: string, payload: unknown = {}, ctx: unknown = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
	}

	lastMessage(): string {
		return this.messages.at(-1)?.content ?? "";
	}
}

export interface FakeContextOptions {
	cwd: string;
	mode?: "tui" | "rpc" | "json" | "print";
	inputs?: Array<string | undefined>;
	selects?: Array<string | undefined>;
	confirms?: boolean[];
}

export interface FakeContext {
	ctx: ExtensionCommandContext;
	notifications: Array<{ message: string; type?: string }>;
	statuses: Array<string | undefined>;
	widgets: Array<string[] | undefined>;
}

/** A minimal extension context: dialogs answer from queues, status and widget updates are recorded. */
export function fakeContext(options: FakeContextOptions): FakeContext {
	const notifications: FakeContext["notifications"] = [];
	const statuses: FakeContext["statuses"] = [];
	const widgets: FakeContext["widgets"] = [];
	const inputs = [...(options.inputs ?? [])];
	const selects = [...(options.selects ?? [])];
	const confirms = [...(options.confirms ?? [])];
	const mode = options.mode ?? "tui";
	const ctx = {
		cwd: options.cwd,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		model: { provider: "sim", id: "model" },
		modelRegistry: {},
		signal: undefined,
		ui: {
			notify: (message: string, type?: string) => void notifications.push({ message, ...(type ? { type } : {}) }),
			setStatus: (_key: string, text: string | undefined) => void statuses.push(text),
			setWidget: (_key: string, lines: string[] | undefined) => void widgets.push(lines),
			input: async () => inputs.shift(),
			select: async () => selects.shift(),
			confirm: async () => confirms.shift() ?? false,
			editor: async () => undefined,
			custom: async () => {
				throw new Error("custom UI must go through the injected UiPort in tests");
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionCommandContext, notifications, statuses, widgets };
}
