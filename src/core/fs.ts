import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

export async function dirExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

export async function mtimeMs(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

export async function readText(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function readJson<T = unknown>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonIfExists<T = unknown>(path: string): Promise<T | undefined> {
	if (!(await fileExists(path))) return undefined;
	return readJson<T>(path);
}

/** Writes via a temp file and rename so readers never observe a partially written artifact. */
export async function writeTextAtomic(path: string, content: string): Promise<void> {
	await ensureDir(dirname(path));
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, path);
}

export async function writeJson(path: string, data: unknown): Promise<void> {
	await writeTextAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
}

export async function appendJsonl(path: string, record: unknown): Promise<void> {
	await ensureDir(dirname(path));
	await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function writeJsonl(path: string, records: readonly unknown[]): Promise<void> {
	await writeTextAtomic(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

/** Reads JSON Lines, skipping blank and malformed lines (a crash can leave a torn last line). */
export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
	if (!(await fileExists(path))) return [];
	const out: T[] = [];
	for (const line of (await readFile(path, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// torn write from an interrupted run
		}
	}
	return out;
}
