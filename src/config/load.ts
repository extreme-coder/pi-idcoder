import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { Value } from "typebox/value";
import { fileExists, readJson, writeJson } from "../core/fs.ts";
import { slugify } from "../core/text.ts";
import { type IdcoderConfig, IdcoderConfigSchema } from "./schema.ts";

export const CONFIG_DIR = ".idcoder";
export const CONFIG_FILE = "config.json";

export class ConfigError extends Error {
	readonly issues: string[];

	constructor(message: string, issues: string[] = []) {
		super(issues.length ? `${message}\n${issues.map((i) => `  - ${i}`).join("\n")}` : message);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

export function defaultConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR, CONFIG_FILE);
}

/** Applies schema defaults and validates; throws ConfigError listing every violation. */
export function resolveConfig(raw: unknown): IdcoderConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new ConfigError("Config must be a JSON object.");
	}
	const withDefaults = Value.Default(IdcoderConfigSchema, Value.Clone(raw));
	if (!Value.Check(IdcoderConfigSchema, withDefaults)) {
		const issues = Value.Errors(IdcoderConfigSchema, withDefaults).map(
			(e) => `${e.instancePath || "/"}: ${e.message}`,
		);
		throw new ConfigError("Invalid idcoder config.", issues);
	}
	return withDefaults;
}

export async function loadConfig(path: string): Promise<IdcoderConfig> {
	if (!(await fileExists(path))) {
		throw new ConfigError(`No idcoder config at ${path}. Run /idcoder init to create one.`);
	}
	let raw: unknown;
	try {
		raw = await readJson(path);
	} catch (error) {
		throw new ConfigError(`Could not parse ${path}: ${(error as Error).message}`);
	}
	return resolveConfig(raw);
}

export interface ConfigSeed {
	researchQuestion: string;
	data: string;
	slug?: string;
	coder?: string;
}

export function configTemplate(seed: ConfigSeed): Record<string, unknown> {
	return {
		study: {
			researchQuestion: seed.researchQuestion,
			data: seed.data,
			...(seed.slug ? { slug: seed.slug } : {}),
		},
		models: { coder: seed.coder ?? "current", deductive: [], judges: [] },
		embeddings: { provider: "openai-compatible", model: "text-embedding-3-small" },
		review: { enabled: true, mode: "auto" },
	};
}

export async function writeConfigTemplate(path: string, seed: ConfigSeed): Promise<IdcoderConfig> {
	const template = configTemplate(seed);
	const config = resolveConfig(template);
	await writeJson(path, template);
	return config;
}

export function resolveDataPath(config: IdcoderConfig, projectDir: string): string {
	return isAbsolute(config.study.data) ? config.study.data : resolve(projectDir, config.study.data);
}

export function resolveSlug(config: IdcoderConfig): string {
	if (config.study.slug) return config.study.slug;
	return slugify(basename(config.study.data, extname(config.study.data)));
}

export function resolveViewerDir(config: IdcoderConfig, projectDir: string): string {
	return isAbsolute(config.viewer.dataDir) ? config.viewer.dataDir : resolve(projectDir, config.viewer.dataDir);
}
