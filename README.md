# pi-idcoder

**ID-Coder for [pi](https://github.com/earendil-works/pi).** An agentic thematic-analysis pipeline implementing the whole framework in *ID-Coder: LLM-based Inductive-Deductive Coder for Qualitative Coding* (ARR 2608), Figure 1. Ported from [Thematic_Analysis_Main](https://github.com/nimamot/Thematic_Analysis_Main).

- **Inductive coding agent.** Builds a codebook from a corpus through inspectable stages: open coding, validator, consolidation, clustering, labeling, an **optional human review gate**, refinement, codebook enrichment, hierarchy, meta-themes, and a research report.
- **Deductive recoding agents.** Re-code every quote from the codebook alone, at three levels of codebook detail.
- **Evaluation.** Krippendorff's α between the two, a blind pool of their disagreements, LLM judges, and human judges.

Everything runs inside pi. LLM calls go through pi's model registry, so any provider pi supports works: OpenRouter, Anthropic, OpenAI, Google, or a local vLLM/SGLang/Ollama endpoint. The human gate opens as a terminal UI in your pi session or in the Graph Builder web viewer.

## How Figure 1 maps onto the code

| Figure 1 box | Stage / module |
|---|---|
| Text corpus | `src/corpus/load.ts` (CSV, TSV, JSONL, TXT) |
| Open coding (grounded codes) | `open_coding` · `src/stages/open-coding.ts` |
| Validator (regenerate on fail) | `openCoding.validator` · same stage, generator-validator loop |
| Consolidation (merge near-duplicates) | `src/cluster/dedup.ts` (exact + embedding near-duplicate union-find) |
| Clustering (K-means + labels) | `axial_clustering` · `src/cluster/axial-embedding.ts` (silhouette-selected K) or `axial-llm.ts` (HICode-style); `cluster_labeling` · `src/stages/labeling.ts` |
| Codebook (definition + criteria) | `codebook_enrichment` · `src/enrichment/codebook.ts` |
| **Human review (optional edit gate)** | `codebook_review` · `src/stages/review-gate.ts`, `src/review/*`, terminal UI `src/ui/*`, browser viewer `src/viewer/*` |
| Refinement (applies reviewer edits) | gate materialization + `refine_assignments` · `src/stages/refine.ts` |
| Meta-themes, hierarchy, report | `hierarchy`, `meta_themes`, `dimension_enrichment`, `tree_assembly`, `research_report`, `cooccurrence`, `viewer_export` |
| Deductive agents (label / +definition / +criteria) | `src/evaluation/recode.ts` |
| Predicted labels (meta-theme or NONE) | `evaluation/recode/<model>/<level>/reclassified.jsonl` |
| Krippendorff's α | `src/evaluation/krippendorff.ts`, `agreement.ts` |
| Disagreements | `src/evaluation/disagreements.ts` (de-duplicated blind A/B items) |
| LLM judges (blind) | `src/evaluation/judge.ts` (four-way outcomes from §3.3, or binary) |
| Human judges | `/idcoder judge` · `src/ui/judge-model.ts`, `src/evaluation/human.ts` |

## Install

Requires Node ≥ 22.19 and pi ≥ 1.1.

```bash
pi install git:github.com/<you>/pi-idcoder        # or: pi install ./pi-idcoder
pi -e ./pi-idcoder                               # try it for one session without installing
```

The package provides one extension (tools plus the `/idcoder` command) and one agent skill (`skill:idcoder`).

## Quick start

```text
/idcoder init        research question + corpus → .idcoder/config.json
/idcoder run         runs until the human codebook review gate
/idcoder review      review clusters in the terminal (or /idcoder viewer for the browser)
/idcoder run         resumes: refinement → enrichment → hierarchy → meta-themes → report
/idcoder evaluate    deductive recoding, α, disagreement pool, LLM judges, summary
/idcoder judge ana   blind human judging as annotator "ana"
```

You can also ask the agent directly ("code these survey answers into themes"). It uses the `idcoder_*` tools and stops when the codebook needs your review. **The agent never approves a codebook itself.**

| Tool | Purpose |
|---|---|
| `idcoder_run` | Run or resume (`from` / `until` a stage). Ends the agent turn when paused for review |
| `idcoder_status` | Stage-by-stage status and the next step |
| `idcoder_evaluate` | The evaluation half of Figure 1 |
| `idcoder_inspect` | Codebook, one cluster with grounded examples, meta-themes, report, evaluation, usage, trace |

While a stage runs, progress shows in pi's status bar and a widget. Every finished unit of work is checkpointed, so an aborted or crashed run resumes where it stopped. `run --from <stage>` recomputes that stage and everything after it.

## The human review gate

After labeling, the pipeline writes the proposal (`codebook_v1.json`), exports it with hover evidence to `.idcoder/viewer-data/codebook-reviews/<slug>/`, and asks a researcher for approval. Edits are the operations in §3.1:

- rename labels
- edit descriptions
- reassign codes
- split clusters
- merge clusters
- drop clusters (deleting their codes or keeping them as orphans)
- create human-authored clusters
- flag a cluster as needing more evidence (refinement then leaves it untouched)

Clusters are listed least-confident first. Every edit is undoable and recorded with provenance (`llm`, `llm+edited`, `human`). Provenance is written to `codebook_provenance.json`.

How the gate reaches you is set by `review.mode`:

| Mode | Behaviour |
|---|---|
| `auto` (default) | Terminal review screen when pi is interactive. Otherwise the run pauses until an approval file exists |
| `tui` | Same as `auto` |
| `browser` | Serves the pinned Graph Builder viewer locally, opens it, and waits for **Approve & export**. The approval is saved straight back into the run |
| `file` | Always pauses. Approvals are `codebook_v2.json` in the run's `data/` folder or the viewer's `codebook-reviews/<slug>/` folder. With `review.waitForFile: true`, a batch or HPC run polls for that file instead of pausing (`timeoutSec`, `pollIntervalSec`) |

Set `review.enabled: false` for fully automated runs.

## Configuration

`.idcoder/config.json` is validated with a schema, and unknown keys are rejected. Only `study.researchQuestion` and `study.data` are required. Everything else has sensible defaults. Model references are `provider/model-id` as pi lists them, or `current` for the session model.

```jsonc
{
  "study": { "researchQuestion": "What do players complain about?", "data": "data/reviews.csv", "slug": "games" },
  "models": {
    "coder": "openrouter/qwen/qwen3-30b-a3b-instruct-2507",
    "validator": "…", "clustering": "…", "enrichment": "…", "report": "…",   // each defaults to coder
    "deductive": ["openrouter/google/gemma-3-27b-it", "openrouter/qwen/qwen3-32b"],
    "judges": ["openrouter/openai/gpt-4o-mini", "openrouter/google/gemini-2.5-flash-lite"],
    "temperature": 0, "maxTokens": 4096, "maxRetries": 3,
    "extraBody": { "chat_template_kwargs": { "enable_thinking": false } }   // OpenAI-compatible servers only
  },
  "embeddings": { "provider": "openai-compatible", "model": "text-embedding-3-small", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
  "review": { "enabled": true, "mode": "auto" }
}
```

| Setting | Default |
|---|---|
| `openCoding.validator` / `maxRetries` / `workers` | `false` / 2 / 8 |
| `clustering.method` | `embedding` |
| `clustering.kMin`, `kMaxCap`, `kMaxDivisor`, `nearDuplicateThreshold` | 5, 50, 3, 0.95 |
| `clustering.llm.maxIterations`, `batchSize`, `contextLength`, `maxCompletion` | 3, 100, 16384, 8192 |
| `labeling.strategy`, `samples`, `sampleSize`, `workers` | `nsampling`, 5, 15, 8 |
| `refine.topKOtherClusters`, `maxCodesPerCall` | 5, 44 |
| `enrichment.enabled`, `workers`, `dimensionEvidence` | `true`, 4, `sampled` |
| `hierarchy.workers`, `assignBatch`, `embedDrain` | 8, 40, `false` |
| `hierarchy.refine.enabled`, `maxCodesPerBucket`, `maxDepth`, `llmMaxCodes` | `true`, 48, 8, 48 |
| `review.*` | see above |
| `viewer.export`, `version`, `port` | `true`, `0.2.8`, 8765 |
| `skills.enabled`, `dir` | `true`, bundled |
| `evaluation.levels` | all three |
| `evaluation.judge.outcomes` | `four_way` |
| `seed` | 20260726 |

**Local models.** Add your SGLang, vLLM, or Ollama endpoint to pi's `models.json` as an `openai-completions` provider and reference it as `myprovider/model`. Per-call system prompts and JSON-schema output constraints work through pi. Use `models.extraBody` for server-specific fields.

**Embeddings.** `openai-compatible` works with OpenAI, OpenRouter, LM Studio, vLLM, and Ollama. For a fully local setup, install the optional `@huggingface/transformers` and use `{ "provider": "transformers", "model": "onnx-community/Qwen3-Embedding-0.6B-ONNX", "pooling": "last_token" }`.

## Outputs

Each run lives in `.idcoder/runs/<slug>/`. The data files use the names the Graph Builder viewer expects, so it reads them unchanged.

```text
state.json                    stage status, timings, summaries, errors
config.snapshot.json          the config the run last used
data/gt_open_codes_all_reviews.md  gt_codes_only.json  gt_source_memory.json
data/gt_clustered_codes.json  codebook.json  codebook_confidence.json
data/codebook_v1.json  codebook_v2.json  codebook_provenance.json
data/gt_hierarchy.json  gt_meta_themes.json  gt_meta_themes_enriched.json
data/gt_global_graph.json  research_report.md  gt_cooccurrence.json
logs/gt_agent_trace.log       human-readable agent trace
logs/gt_llm_usage.jsonl       one line per LLM call: stage, skill, model, tokens, cost, latency
evaluation/recode/<model>/<level>/reclassified.jsonl  agreement.json
evaluation/disagreements/item_pool.jsonl  judges/<model>.jsonl  human/<annotator>.jsonl
evaluation/summary.json  summary.md
```

## Design

- **Orchestration.** An explicit stage graph persists per-stage state and per-unit checkpoints, resumes after crashes, pauses at the gate, and can re-run from any stage. Approvals come from the terminal, the browser viewer, or files.
- **Reproducibility.** One seed drives n-sampling, k-means, silhouette sampling, and A/B option order.
- **Re-runs.** `run --from <stage>` restores the artifacts that stage originally read (snapshots of files rewritten in place), so a re-run reproduces a fresh run instead of re-refining refined clusters. Checkpoints are keyed to the inputs and settings that shape them: text, research question, models, and codebook.
- **Codebook edits.** Review operations replay correctly when edits chain (merge into a cluster, then split it), and cluster ids are never reused.
- **Evaluation.** Four-way judging (prefer A / prefer B / both / neither), human judging with a shared sample for inter-annotator α, and Krippendorff's α computed in code (validated against Krippendorff 2011 and the `krippendorff` package). Ground truth resolves deduplication aliases, so merged codes are never dropped.
- **Viewer safety.** The local approval endpoint only accepts same-origin JSON submissions. Approvals that reference codes outside the run are refused.
- **Robustness.** Transient provider errors are retried with exponential backoff. Usage and cost are accounted per call and reported to pi. Partial enrichment results are checkpointed, so one failing cluster doesn't force the whole stage to rerun. Hard truncation of the report graph is flagged.

## Development

```bash
npm install
npm run check          # typecheck + lint + all offline tests (including real pi over RPC)
npm run test:coverage  # coverage with thresholds
npm run test:live      # real models via OpenRouter (needs OPENROUTER_API_KEY); see TESTING.md
```

TESTING.md describes the test strategy, what each layer proves, and the protocol for checking research validity against the paper.
