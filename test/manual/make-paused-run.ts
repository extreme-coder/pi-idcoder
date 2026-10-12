import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveConfig } from "../../src/config/load.ts";
import { writeJson } from "../../src/core/fs.ts";
import { RunSession } from "../../src/pipeline/session.ts";
import { pausingReviewGateway } from "../../src/review/gateway.ts";
import { HashingEmbedder } from "../helpers/fake-embedder.ts";
import { writeCorpus } from "../helpers/harness.ts";
import { gameReviews, SimulatedGateway } from "../helpers/simulated-llm.ts";

/** Builds a project whose run is paused at the codebook review gate (offline, simulated model). */
const dir = process.argv[2];
if (!dir) throw new Error("usage: node --experimental-strip-types test/manual/make-paused-run.ts <dir>");
await mkdir(dir, { recursive: true });
await writeCorpus(dir, gameReviews());
const raw = {
	study: { researchQuestion: "What frustrates players?", data: "corpus.csv", slug: "tui" },
	clustering: { kMin: 2, kMaxCap: 8 },
};
await writeJson(join(dir, ".idcoder", "config.json"), raw);
const session = new RunSession({
	projectDir: dir,
	config: resolveConfig(raw),
	gateway: new SimulatedGateway(),
	embedder: new HashingEmbedder(),
});
console.log((await session.run({ review: pausingReviewGateway })).status);
