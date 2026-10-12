import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ViewerHost } from "../viewer/host.ts";
import { registerCommands } from "./commands.ts";
import { type ControllerDeps, defaultControllerDeps, IdcoderController } from "./controller.ts";
import { registerTools } from "./tools.ts";

export const CONFIG_FLAG = "idcoder-config";

export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
	if (platform === "darwin") return ["open", [url]];
	if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
	return ["xdg-open", [url]];
}

/**
 * Wires ID-Coder into pi. Nothing long-lived starts here: the viewer server starts on demand and
 * every run/server is stopped from `session_shutdown`.
 */
export function registerIdcoder(pi: ExtensionAPI, overrides: Partial<ControllerDeps> = {}): IdcoderController {
	pi.registerFlag(CONFIG_FLAG, {
		description: "Path to the ID-Coder config (default .idcoder/config.json)",
		type: "string",
	});
	const defaults = defaultControllerDeps(
		new ViewerHost(),
		async (url) => {
			const [command, args] = browserCommand(process.platform, url);
			await pi.exec(command, args);
		},
		() => {
			const value = pi.getFlag(CONFIG_FLAG);
			return typeof value === "string" && value ? value : undefined;
		},
	);
	const controller = new IdcoderController({ ...defaults, ...overrides });
	registerTools(pi, controller);
	registerCommands(pi, controller);
	pi.on("session_shutdown", async () => {
		await controller.shutdown();
	});
	return controller;
}
