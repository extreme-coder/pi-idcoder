import { visibleWidth } from "@earendil-works/pi-tui";
import type { ScreenFactory, UiPort } from "../../src/ui/port.ts";
import { plainStyler } from "../../src/ui/styler.ts";

export const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	enter: "\r",
	escape: "\x1b",
	tab: "\t",
	space: " ",
	pageDown: "\x1b[6~",
} as const;

/**
 * Scripted UiPort: each screen consumes the next batch of key presses (it must finish the screen),
 * and dialogs answer from their queues. Every render is checked against the width contract.
 */
export class FakeUi implements UiPort {
	readonly renders: string[][] = [];
	readonly notifications: string[] = [];
	readonly dialogs: string[] = [];
	private readonly keyBatches: string[][];
	private readonly inputs: Array<string | undefined>;
	private readonly selects: Array<string | undefined>;
	private readonly confirms: boolean[];
	private readonly editors: Array<string | undefined>;
	readonly width: number;

	constructor(script: {
		keys?: string[][];
		inputs?: Array<string | undefined>;
		selects?: Array<string | undefined>;
		confirms?: boolean[];
		editors?: Array<string | undefined>;
		width?: number;
	}) {
		this.keyBatches = [...(script.keys ?? [])];
		this.inputs = [...(script.inputs ?? [])];
		this.selects = [...(script.selects ?? [])];
		this.confirms = [...(script.confirms ?? [])];
		this.editors = [...(script.editors ?? [])];
		this.width = script.width ?? 100;
	}

	private checkWidth(lines: string[]): void {
		for (const line of lines) {
			if (visibleWidth(line) > this.width)
				throw new Error(`Line exceeds width ${this.width}: ${JSON.stringify(line)}`);
		}
	}

	async screen<T>(factory: ScreenFactory<T>): Promise<T> {
		const keys = this.keyBatches.shift();
		if (!keys) throw new Error("FakeUi: no key batch left for screen");
		let result: { value: T } | undefined;
		const component = factory(
			() => {},
			plainStyler,
			(value) => {
				result = { value };
			},
		);
		const first = component.render(this.width);
		this.checkWidth(first);
		this.renders.push(first);
		for (const key of keys) {
			if (result) throw new Error("FakeUi: screen finished before all keys were consumed");
			component.handleInput(key);
			const lines = component.render(this.width);
			this.checkWidth(lines);
			this.renders.push(lines);
		}
		if (!result) throw new Error(`FakeUi: screen not finished after keys ${JSON.stringify(keys)}`);
		return result.value;
	}

	async input(title: string): Promise<string | undefined> {
		this.dialogs.push(`input:${title}`);
		return this.inputs.shift();
	}

	async select(title: string, options: string[]): Promise<string | undefined> {
		this.dialogs.push(`select:${title}:${options.join("|")}`);
		return this.selects.shift();
	}

	async confirm(title: string): Promise<boolean> {
		this.dialogs.push(`confirm:${title}`);
		return this.confirms.shift() ?? false;
	}

	async editor(title: string): Promise<string | undefined> {
		this.dialogs.push(`editor:${title}`);
		return this.editors.shift();
	}

	notify(message: string): void {
		this.notifications.push(message);
	}

	lastRender(): string {
		return this.renders.at(-1)?.join("\n") ?? "";
	}
}
