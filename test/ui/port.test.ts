import { describe, expect, it } from "vitest";
import { piUi } from "../../src/ui/port.ts";
import { plainStyler } from "../../src/ui/styler.ts";

describe("piUi adapter", () => {
	it("maps screens onto ctx.ui.custom and forwards dialogs", async () => {
		const calls: string[] = [];
		const ctx = {
			ui: {
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						kb: unknown,
						done: (v: unknown) => void,
					) => { render(w: number): string[] },
				) => {
					let result: unknown;
					const component = factory({ requestRender: () => calls.push("render") }, plainStyler, {}, (v) => {
						result = v;
					});
					calls.push(component.render(10).join(""));
					return result;
				},
				input: async (t: string) => `input:${t}`,
				select: async (t: string, o: string[]) => `select:${t}:${o.length}`,
				confirm: async () => true,
				editor: async (_t: string, p?: string) => `editor:${p}`,
				notify: (m: string) => calls.push(`notify:${m}`),
			},
		};
		const ui = piUi(ctx as never);
		const value = await ui.screen<string>((requestRender, styler, done) => {
			requestRender();
			done(styler.bold("ok"));
			return { render: () => ["screen"], handleInput: () => {}, invalidate: () => {} };
		});
		expect(value).toBe("ok");
		expect(calls).toEqual(["render", "screen"]);
		expect(await ui.input("t")).toBe("input:t");
		expect(await ui.select("s", ["a", "b"])).toBe("select:s:2");
		expect(await ui.confirm("c", "m")).toBe(true);
		expect(await ui.editor("e", "pre")).toBe("editor:pre");
		ui.notify("hi");
		expect(calls).toContain("notify:hi");
	});
});
