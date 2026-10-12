import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Styler } from "./styler.ts";

export interface ScreenComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
}

export type ScreenFactory<T> = (
	requestRender: () => void,
	styler: Styler,
	done: (result: T) => void,
) => ScreenComponent;

/** The interactive surface the review and judging flows need; tests provide a scripted fake. */
export interface UiPort {
	screen<T>(factory: ScreenFactory<T>): Promise<T>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Adapts pi's extension UI: screens become full-width custom components with keyboard focus. */
export function piUi(ctx: ExtensionContext): UiPort {
	return {
		screen: (factory) =>
			ctx.ui.custom((tui, theme, _keybindings, done) => factory(() => tui.requestRender(), theme, done)),
		input: (title, placeholder) => ctx.ui.input(title, placeholder),
		select: (title, options) => ctx.ui.select(title, options),
		confirm: (title, message) => ctx.ui.confirm(title, message),
		editor: (title, prefill) => ctx.ui.editor(title, prefill),
		notify: (message, type) => ctx.ui.notify(message, type),
	};
}
