import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerIdcoder } from "../../src/extension/register.ts";

export default function idcoder(pi: ExtensionAPI): void {
	registerIdcoder(pi);
}
