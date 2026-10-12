import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../prompts/system/", import.meta.url));

/** Drops a leading `---` YAML block so frontmatter never reaches the model. */
export function stripFrontmatter(text: string): string {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("---")) return text.trim();
	const lines = trimmed.split(/\r?\n/);
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]!.trim() === "---")
			return lines
				.slice(i + 1)
				.join("\n")
				.trim();
	}
	return text.trim();
}

/**
 * Pipeline "skills" are stable per-phase system prompts stored as markdown. A missing file means
 * the call is sent with the user prompt only, as in the original pipeline.
 */
export class SkillLibrary {
	private readonly cache = new Map<string, Promise<string>>();
	private readonly enabled: boolean;
	private readonly dirs: string[];

	constructor(options: { enabled: boolean; overrideDir?: string | undefined }) {
		this.enabled = options.enabled;
		this.dirs = options.overrideDir ? [options.overrideDir, BUNDLED_SKILLS_DIR] : [BUNDLED_SKILLS_DIR];
	}

	systemPrompt(skill: string): Promise<string> {
		if (!this.enabled || !/^[a-z0-9_]+$/.test(skill)) return Promise.resolve("");
		let pending = this.cache.get(skill);
		if (!pending) {
			pending = this.read(skill);
			this.cache.set(skill, pending);
		}
		return pending;
	}

	private async read(skill: string): Promise<string> {
		for (const dir of this.dirs) {
			try {
				return stripFrontmatter(await readFile(join(dir, `${skill}.md`), "utf8"));
			} catch {
				// try the next directory
			}
		}
		return "";
	}
}
