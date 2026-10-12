import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunPaths } from "../../src/artifacts/paths.ts";
import { ArtifactStore } from "../../src/artifacts/store.ts";
import { resolveConfig } from "../../src/config/load.ts";
import type { IdcoderConfig } from "../../src/config/schema.ts";
import { type LogEntry, TraceLogger } from "../../src/core/logger.ts";
import { Rng } from "../../src/core/random.ts";
import { type CorpusDocument, parseCsv } from "../../src/corpus/load.ts";
import type { Embedder } from "../../src/embeddings/embedder.ts";
import type { LlmClient } from "../../src/llm/types.ts";
import type { StageContext, StageProgress } from "../../src/pipeline/stage.ts";
import { pausingReviewGateway, type ReviewGateway } from "../../src/review/gateway.ts";
import { HashingEmbedder } from "./fake-embedder.ts";

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

export async function tempProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "idcoder-"));
}

export function testConfig(overrides: DeepPartial<IdcoderConfig> = {}): IdcoderConfig {
	const { study, ...rest } = overrides;
	return resolveConfig({
		...rest,
		study: { researchQuestion: "What frustrates players?", data: "corpus.csv", slug: "test", ...study },
	});
}

export interface TestContext extends StageContext {
	logs: LogEntry[];
	progressUpdates: StageProgress[];
}

export async function makeContext(options: {
	llm: LlmClient;
	config?: IdcoderConfig;
	projectDir?: string;
	embedder?: Embedder;
	review?: ReviewGateway;
	documents?: CorpusDocument[];
	signal?: AbortSignal;
}): Promise<TestContext> {
	const projectDir = options.projectDir ?? (await tempProject());
	const config = options.config ?? testConfig();
	const paths = RunPaths.forSlug(projectDir, config.study.slug ?? "test");
	const logger = new TraceLogger(paths.trace);
	const logs: LogEntry[] = [];
	logger.subscribe((e) => logs.push(e));
	const progressUpdates: StageProgress[] = [];
	const documents = options.documents ?? [];
	return {
		config,
		projectDir,
		slug: config.study.slug ?? "test",
		paths,
		store: new ArtifactStore(paths),
		llm: options.llm,
		embedder: options.embedder ?? new HashingEmbedder(),
		logger,
		rng: new Rng(config.seed),
		review: options.review ?? pausingReviewGateway,
		signal: options.signal,
		corpus: async () => documents,
		progress: (p) => progressUpdates.push(p),
		logs,
		progressUpdates,
	};
}

export async function writeCorpus(
	projectDir: string,
	rows: readonly string[],
	name = "corpus.csv",
): Promise<CorpusDocument[]> {
	const csv = `id,text\n${rows.map((r, i) => `r${i + 1},"${r.replace(/"/g, '""')}"`).join("\n")}\n`;
	await writeFile(join(projectDir, name), csv, "utf8");
	return parseCsv(csv, {});
}
