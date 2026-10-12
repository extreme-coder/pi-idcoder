import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type StyleColor = "accent" | "muted" | "dim" | "text" | "success" | "warning" | "error" | "border";

/** The part of pi's Theme the screens use; tests pass a plain-text implementation. */
export interface Styler {
	fg(color: StyleColor, text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
}

export const plainStyler: Styler = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

export function clip(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}

export function pad(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? clip(text, width) : text + " ".repeat(width - w);
}

export function wrap(text: string, width: number, prefix = ""): string[] {
	const inner = Math.max(1, width - visibleWidth(prefix));
	return wrapTextWithAnsi(text, inner).map((line) => prefix + line);
}

export function rule(styler: Styler, width: number, title = ""): string {
	if (!title || width < 8) return styler.fg("border", "─".repeat(Math.max(1, width)));
	const label = ` ${clip(title, width - 4)} `;
	return (
		styler.fg("border", "──") +
		styler.fg("accent", label) +
		styler.fg("border", "─".repeat(Math.max(0, width - visibleWidth(label) - 2)))
	);
}

/** Keeps `index` visible inside a window of `size` rows starting at `offset`. */
export function scrollWindow(index: number, offset: number, size: number, total: number): number {
	if (total <= size) return 0;
	if (index < offset) return index;
	if (index >= offset + size) return index - size + 1;
	return Math.min(offset, Math.max(0, total - size));
}
