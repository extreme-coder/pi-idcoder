# Testing pi-idcoder

This document describes the test suite, what each layer proves, and how to extend it. Each layer is marked as **implemented and passing** or as a **protocol** (designed but needing resources I did not have). The main missing resource is model API access. Read the [status section](#status-what-has-and-has-not-been-run) before trusting a claim.

## What "correct" means here

A port of a research pipeline can fail in five different ways. Each needs a different kind of test.

| # | Property | Failure it catches | Primary layers |
|---|---|---|---|
| 1 | **Fidelity to the original pipeline** | A prompt changes by one word, a default drifts, a parsing rule loosens | Golden prompts, ported pytest cases, reference oracles |
| 2 | **Fidelity to the paper's method** (ID-Coder, Fig. 1, §3) | Wrong α, judge sees which side is inductive, deductive agent sees criteria it shouldn't | Algorithm oracles, evaluation tests, prompt contracts |
| 3 | **Correct pi integration** | Extension fails to load, tool schema rejected, model calls bypass pi auth or usage | Real pi over RPC |
| 4 | **Operational robustness** | Lost work on crash, double billing on resume, stale approvals, hung runs | Stage, e2e, and property tests with fault injection |
| 5 | **Research validity with real models** | Prompts that parse on the simulator but not on real models; a codebook that does not transfer | Live suite, parity protocol |

The offline suite (properties 1–4) is deterministic, needs no network or keys, and runs in about 3 seconds. Property 5 needs real models and is covered by the live suite and the parity protocol below.

## The layers

| Layer | Location | Tests | Oracle | Runs |
|---|---|---|---|---|
| L0 Static | `tsc --strict` (incl. `noUncheckedIndexedAccess`), Biome | — | Compiler, linter | Every commit |
| L1 Units | `test/{core,config,llm,embeddings,cluster,evidence,review,viewer}` | 175 | Reference oracles (below) | Every commit |
| L2 Golden prompts | `test/prompts` | 30 | The original Python functions, byte for byte | Every commit |
| L3 Properties | `test/properties` | 8 (×50–200 generated cases each) | Invariants | Every commit |
| L4 Stage contracts | `test/stages` | 84 | Scripted model, fault injection, ported pytest cases | Every commit |
| L5 Pipeline e2e | `test/pipeline`, `test/evaluation` | 43 | Deterministic simulated model | Every commit |
| L6 UI | `test/ui` | 18 | Pure reducers, width contract, scripted flows | Every commit |
| L7 Extension | `test/extension` | 29 | Fake pi API, scripted UI | Every commit |
| L8 Real pi | `test/integration` | 5 | The pi binary over RPC with a mock OpenAI endpoint | Every commit |
| L9 Viewer releases | `test/viewer` (`IDCODER_NETWORK=1`) | 1 | Published Graph Builder bundles | Nightly |
| L10 Live models | `test/live` (`npm run test:live`) | 5 | Invariants on real outputs, cost budget | Manual / nightly with secrets |
| L11 Parity & validity | Protocol in this document | — | The Python pipeline and the paper's results | Before each release |

`npm run check` runs L0–L8: typecheck, lint, and 392 tests, all offline.

## Oracles

A test is only as good as its oracle. These are the external sources of truth the suite compares against. `test/fixtures/reference/generate.py <path-to-Thematic_Analysis_Main>` regenerates every fixture, and running it reproduces the committed files byte for byte.

- **scikit-learn** (`sklearn.json`):
  - `silhouette_score` on random labelings, matched to 1e-5.
  - The silhouette sweep over k=2..7 on Gaussian blobs, matched to 1e-6 wherever k-means converges to the same optimum.
  - `KMeans` inertia on the blobs, matched to 3 decimals, with a perfect Rand index.
- **Krippendorff (2011)** "Computing Krippendorff's Alpha-Reliability": the nominal worked example (4 coders × 12 units with missing values, α = 0.743). The **`krippendorff` package** supplies four random cases with up to 5 coders and 30% missing data, matched to 12 decimals.
- **Original prompts** (`prompts.json`, `format_codebook.json`):
  - Every prompt function in `agents/core/prompts.py`, `pipeline_helpers.py`, `prompts_reclassify.py`, and `prompts_judge.py`.
  - The inline f-string prompts in the enrichment modules, extracted from source and evaluated in place.
  - `format_codebook` at all three detail levels.
  - 30 cases total, compared byte for byte.
- **Original tests.** Every pytest module has a counterpart: codebook edits, co-occurrence, hierarchy refinement, pipeline helpers, report, source memory, utils, viewer export, state routing, skills, embeddings, evidence I/O, code evidence, and enrichment persistence. The exceptions are Supabase, which was removed, and the env-var config readers, which the schema replaced.
- **Published viewer bundles.** The bundle patcher is exercised against the real v0.2.4 and v0.2.8 releases.

## Determinism

The offline suite never touches the network, wall-clock randomness, or shared state:

- **Seeded RNG.** Every random choice (n-sampling, k-means++, silhouette sampling, A/B order, retry reshuffles) uses `Rng(config.seed)`, forked per stage and cluster.
- **`ScriptedLlm`** answers by skill key and records every request. It is used to test one stage's branches precisely.
- **`SimulatedLlm` / `SimulatedGateway`** understand every pipeline prompt well enough to produce valid, plausible output, inferring the skill from prompt text the way a real model only sees text. This lets the whole pipeline, including evaluation, run end to end offline through the real `LlmService` (skills, retries, usage).
- **`HashingEmbedder`** is a deterministic bag-of-words embedder: texts sharing words are similar, identical texts are identical.
- **Temp dirs only.** Each test gets its own project directory, and pi children get a private `HOME`.

**Flakiness policy.** There are no sleeps-as-synchronization except bounded polling in the file-wait gateway test. Any flaky test is a bug to fix, not to retry.

## Layer details

### L1 Units: algorithms and infrastructure
- **Algorithms:**
  - k-means++ / Lloyd / mini-batch: optimality on blobs, empty-cluster relocation, determinism, degenerate inputs.
  - Silhouette and the K range, including the n−1 cap the original lacked.
  - Union-find near-duplicate merging.
  - Krippendorff's α.
  - Meta-theme bound repair.
  - HICode label chaining with abandonment.
- **Parsing:**
  - JSON from noisy model output: reasoning blocks, fences, stray braces, control characters, Python literals.
  - Open-coding markdown into snippets.
  - CSV/JSONL/TXT corpora: BOM, quoted newlines, configurable columns.
  - Python list repr.
  - MOVE lines.
- **Infrastructure:**
  - Atomic writes and torn-line-tolerant JSONL.
  - Ordered bounded concurrency with fail-fast and abort.
  - Retry and backoff classification (transient vs permanent).
  - Usage accounting.
  - Config schema defaults, bounds, and unknown-key rejection.
- **pi gateway.** Model-ref resolution (ids containing `/`, `current`), payload decoration (`response_format` for chat completions, `text.format` for Responses, untouched otherwise), and usage mapping.

### L3 Property-based (fast-check)
- **Review sessions.** Any random sequence of up to 25 edits (rename, move, merge, split, drop, restore, create, flag, undo) produces a payload that `applyCodebookReview` accepts. That payload never duplicates a code, accounts for every code unless a delete-drop happened, and rekeys ids to 0..n−1. A random edit followed by undo restores the exact previous payload. These properties guard against two real bugs that example tests caught during development: id reuse after a merge, and replaying chained operations.
- **α.** Invariant under renaming categories and permuting units or coders. Never above 1. Exactly 1 for perfect agreement.
- **Meta-theme repair.** Never loses a cluster and lands within bounds whenever that is achievable.
- **k-means.** Every point is assigned to its nearest center.
- **Infrastructure.** `mapConcurrent` preserves order for any limit and timings. The JSON parser recovers any object from fenced, noisy text.

### L4 Stage contracts with fault injection

Each stage is tested against its own contract with a scripted model.

| Stage | Behaviours verified |
|---|---|
| Open coding | Validator loop (revise until PASS, keep last attempt after max retries); empty output becomes NONE; reasoning stripped; checkpoint reuse keyed by a text hash, so edited documents are re-coded |
| Labeling | first-30 overflow note; n-sampling sample sizes; synthesis prompt contents; invalid or too-long labels fall back to `Cluster N`; per-call failures degrade instead of throwing; low-confidence flags; checkpoint resume |
| Refinement | Only the top-k most similar labels are offered as targets; moves must stay inside the chunk; ambiguous target labels skipped; flagged clusters skipped; rekeying; stale hierarchy keys pruned; chunking |
| Enrichment | Invented ids trigger exactly one correction prompt; batched path for large clusters; examples come only from real snippets (≤3, distinct); failing clusters fail the stage while successful ones stay checkpointed |
| Dimensions | Inclusion constrained to own clusters, exclusion to all; full-evidence neighbour quotes; schema enums |
| Hierarchy | Small clusters stay flat; overflow assignment; unknown sub-theme names ignored; embedding drain; failures fall back to ungrouped; resume by input hash |
| Refine hierarchy | Exact multiset partitions only; recursive splitting; deterministic fallback; batch merge by name; depth cap |
| Review gate | Pause with a viewer-ready proposal and hover evidence; materialize gateway approvals with provenance; pick up browser approvals; ignore and clear approvals left from an earlier review |

**Recommended additions:**
- Corrupted checkpoint lines in every checkpointing stage. Only the generic JSONL reader is tested today.
- An LLM that returns *valid but adversarial* JSON (wrong types in every field) for each parser.

### L5 Pipeline end to end (simulated model)

The full 14-stage pipeline runs on 32 synthetic reviews through the real `RunSession`, `LlmService`, stages, and artifacts.

- **Resume.** Pause at the gate, resume after a researcher's edits, complete. Re-running is free: zero new model calls.
- **Run controls.** `from` recomputes only downstream stages. `until` stops early.
- **Failure and abort.** A mid-pipeline failure is recorded and resumes without redoing finished stages. An abort mid-open-coding resumes from the checkpoint and never re-codes a finished document.
- **Alternatives and validation.** HICode-style LLM clustering. Model-reference validation happens before any work.
- **Artifacts.** Every downstream artifact is checked for structural integrity:
  - every clustered code appears as a tree leaf
  - every cluster is in exactly one meta-theme
  - every criterion example is a grounded snippet
- **Evaluation e2e.** Recoding at three levels with two deductive models, agreement, item pool, two judges, the summary, and idempotent re-runs.

### L6 UI
- **Rendering.** Screens are pure functions of state, so they are tested without a terminal. Every screen at widths 20, 40, 80, and 200 must never exceed the width. This contract found real overflow bugs (rule titles, option headings, page counters), and text assertions caught help text being truncated instead of wrapped.
- **Key handling.** Pure reducers (navigation, paging, focus, action keys, checklist, judging keys per outcome set).
- **Flows.** Scripted `UiPort` sessions cover full editing (rename, describe, flag, move, split, merge, undo, approve), drop/restore/create, validation errors shown on screen, dismissed dialogs as no-ops, cancel confirmation, and selection following the edited cluster.
- **Real terminal smoke** (`test/manual/tui-smoke.py`, POSIX).
  - Builds a paused run offline with `test/manual/make-paused-run.ts`.
  - Starts interactive pi in a pseudo-terminal and types `/idcoder review`.
  - Renames a cluster through pi's input dialog, approves through its confirm dialog, and declines resuming.
  - Asserts that `codebook_v2.json` records the edit as `llm+edited`.
  - It is timing-based, so it is not part of the default suite.

### L7 Extension
- **Registration.** A fake `ExtensionAPI` records registrations: 4 tools, the command, the flag, and shutdown cleanup.
- **Tools.** Executed with a fake context:
  - pause ends the agent turn (`terminate`)
  - failures are `isError`
  - usage reaches pi
  - progress streams through `onUpdate` and the status bar and widget, and is cleared afterwards
  - `inspect` views
  - concurrent runs of one study are refused
  - `session_shutdown` aborts a running pipeline
- **Commands.** Every subcommand, including interactive `init`, terminal review then resume, blind human judging into the summary, and the browser viewer.
- **Review routing.** The review-channel selection matrix across modes and config.

### L8 Real pi over RPC (hermetic)

This is the highest-fidelity offline test. It spawns the **real pi binary** in RPC mode, loading **the package directory** (manifest, extension, skill), with a private `HOME`. pi's **real model runtime** (provider adapter, streaming, auth, payload hooks) is pointed at a **mock OpenAI-compatible server**: `/chat/completions` streams the simulator's answers over SSE, and `/embeddings` serves hashing vectors.

It verifies:
- The command and skill load, and nothing else does.
- The run pauses at the gate and reports next steps.
- An approval resumes the run to completion.
- `response_format` with the JSON schema reaches the HTTP request through pi's OpenAI adapter.
- Evaluation, status, usage, and argument errors behave as expected.

### L9 Viewer releases
`IDCODER_NETWORK=1 npx vitest --run test/viewer` downloads v0.2.4 and v0.2.8 and checks that the approval hook patches both. Run it nightly: a new viewer release that changes the download helper fails here first.

### L10 Live models (`test/live/live-openrouter.test.ts`)

Drives real pi on a 24-review corpus (`test/fixtures/corpus/live-reviews.csv`) with real models through OpenRouter. Real outputs vary, so the assertions are **invariants any competent model must satisfy**, not exact values:

| Invariant | Threshold |
|---|---|
| Open-code evidence quotes found verbatim in their documents | ≥ 85% |
| Off-topic reviews (r13, r14, r23) receive no codes | all three |
| Codes per document | ≤ 3 |
| Pipeline completes after an approval | all stages `done` |
| Cluster labels distinct; every cluster in exactly one meta-theme; ≥ 2 meta-themes | exact |
| Every enriched cluster has a definition (> 20 chars) and ≥ 1 criterion | all |
| Report has the three required sections | all |
| Parse-failure rate across labeling / enrichment / hierarchy | < 5% of calls |
| Invalid-id correction retries | ≤ 10% of calls |
| Deductive recoding at `full`: α computed, unresolved < 5%, % agreement > 0.4 | per model |
| Judge coverage | > 95% judged |
| Total cost | < `IDCODER_LIVE_MAX_USD` (default $1.00) |

Run it with:

```bash
OPENROUTER_API_KEY=... npm run test:live
# optional overrides
IDCODER_LIVE_CODER=openrouter/qwen/qwen3-30b-a3b-instruct-2507
IDCODER_LIVE_DEDUCTIVE=openrouter/google/gemma-3-27b-it,openrouter/qwen/qwen3-32b
IDCODER_LIVE_JUDGES=openrouter/openai/gpt-4o-mini
IDCODER_LIVE_EMBED_MODEL=openai/text-embedding-3-small   # via OpenRouter /embeddings
IDCODER_LIVE_CLUSTERING=llm                              # skip embeddings entirely
IDCODER_LIVE_MAX_USD=0.50
```

If pi's catalog does not know a model id, run `pi update --models` or add it to pi's `models.json`. Expect roughly 600–900 calls and well under a dollar with small models. The budget assertion enforces the cap.

**Model matrix for releases.** Run L10 with one model per family the paper used:
- Qwen (inductive)
- Gemma and Qwen (deductive)
- A non-overlapping family for judges, to limit self-preference bias (§3.3)

Also run one OpenAI-compatible local endpoint to cover `extraBody`.

### L11 Parity with the Python pipeline and validity against the paper (protocol)

Unit-level parity is proven by golden prompts and ported tests. Distribution-level parity needs real model runs. The protocol:

1. **Same inputs.** Run the Python pipeline and pi-idcoder on the same corpus with the same model through the same endpoint. Use the paper's four datasets (AI Posts, Climate, AI Healthcare, School Burnout), 3 seeds each, `temperature = 0`. Use the same embedding model (Qwen3-Embedding-0.6B; locally via `embeddings.provider = "transformers"`, `pooling = "last_token"`).
2. **Compare, per dataset, with bootstrap 95% CIs over documents.** The JS and Python RNGs differ, so compare distributions, not exact outputs.

   | Quantity | Acceptance band |
   |---|---|
   | Codes per document | means within ±10% |
   | Abstention (NONE) rate | within ±5 points |
   | Unique codes after dedup | within ±10% |
   | Chosen K | within ±2 |
   | Silhouette at chosen K | within ±0.05 |
   | Label overlap: share of Python labels with a TS label at embedding cosine ≥ 0.8 | ≥ 0.7 |
   | Meta-theme count | within bounds in both |
   | Enrichment criteria count | means within ±15% |
   | Parse-failure rate | TS ≤ Python |

3. **Reconstruction agreement against Figure 2.**
   - For each dataset, deductive model, and detail level, compute α between inductive and deductive labels.
   - Check that α falls inside the per-dataset range Figure 2 reports for comparable models.
   - Check that α orders `theme_only` < `theme_def` ≤ `full` on most datasets, as the paper's ablation predicts.
   - A systematic gap larger than 0.1 points to a port defect (prompt, codebook formatting, ground-truth mapping) before it points to model variance.
4. **Judge study (§3.3).**
   - Run three judges from model families disjoint from the coders, with randomized A/B order.
   - Report the deductive share of decisive verdicts, the both/neither rates, and inter-judge α.
   - The paper finds judges generally prefer the deductive assignment and agree more with each other than humans do. Reproduce the direction of both findings.
   - For humans, `/idcoder judge` gives every annotator the same seeded sample (default 50) so that inter-annotator α is defined. Reproduce the paper's 20 × 50 design with `evaluation.human.itemsPerAnnotator = 50`.
5. **Human gate usability.** Have 3–5 researchers each review one codebook with `/idcoder review` and one with the browser viewer. Measure completion time and edits made. Then confirm that the applied codebook matches their intent: every edit is reflected and provenance is correct.

## Manual QA checklist (real terminal and browser)

Automated tests cover rendering contracts and flows. These checks need eyes:

- [ ] `/idcoder review` in pi's fullscreen mode (regular mode is covered by `test/manual/tui-smoke.py`), at a narrow (60 col) and a wide terminal, in light and dark themes. The selected row is readable and the help line wraps.
- [ ] Long labels, unicode, and emoji in codes and quotes render without misalignment.
- [ ] Every action dialog: rename, describe (multi-line editor), merge, split, move, drop/restore, new, undo, approve, cancel with unsaved edits.
- [ ] `idcoder_run` invoked by the agent in the TUI opens the review screen mid-tool, and the turn ends cleanly after approval.
- [ ] Esc during a run aborts it. The next `/idcoder run` resumes without re-billing finished work (compare `gt_llm_usage.jsonl` line counts).
- [ ] `/idcoder viewer` opens the browser. **Approve & export** in the Codebook review tab saves `codebook_v2.json` (and still downloads the file). `/idcoder run` continues. The Library tab shows the finished project.
- [ ] `review.mode = "browser"` blocks the run until approval and times out to a pause.
- [ ] `/idcoder judge` never reveals which option is inductive. Judgments survive quitting mid-way.
- [ ] Windows: viewer launch (`cmd /c start`), paths with spaces, CRLF corpora.

**Recommended automation for the browser path.** A Playwright test that serves a prepared run, clicks through the viewer's Codebook review tab, and asserts the approval lands in the run.

## Coverage, mutation testing, CI

- **Coverage** (`npm run test:coverage`, v8), in-process: 97.7% lines, 95.6% statements, 96.2% functions, 82.9% branches. Thresholds are enforced at 85/85/75/85 (lines/functions/branches/statements). `PiModelGateway` is additionally covered across the process boundary by L8, which in-process coverage cannot see.
- **Mutation testing (recommended).** Run Stryker on `src/cluster`, `src/evaluation/krippendorff.ts`, `src/review/apply.ts`, `src/review/session.ts`, and `src/core/json.ts`, targeting a ≥ 80% mutation score. These modules have strong oracles, so surviving mutants indicate missing assertions rather than equivalent mutants.
- **CI matrix:**

  | Job | Scope | When |
  |---|---|---|
  | `check` | L0–L8 on ubuntu, macOS, windows × Node 22.19 / latest × pi 1.1.0 / latest | Every push |
  | `viewer` | L9 | Nightly |
  | `live` | L10 with secrets and the budget cap | Manual dispatch and weekly |
  | `parity` | L11 | Before releases (needs a GPU host for the paper's local models) |

## Status: what has and has not been run

| Layer | Status |
|---|---|
| L0–L8 | Implemented, run locally on macOS with Node 22.22.1 and pi 1.1.0: **392 passed, 0 failed**. Lint and strict typecheck clean |
| L9 | Implemented and run once locally: both published viewer releases patch successfully |
| L10 | Implemented and typechecked, **not executed**: no OpenRouter key was available. Default model ids are examples; confirm them against pi's catalog before the first run |
| L11 | **Protocol only**: needs real models, the Python pipeline's runtime (SGLang + GPU), and the paper's datasets |
| Real-terminal TUI | Run once locally with `test/manual/tui-smoke.py`: the review screen renders in pi's interactive TUI, and rename, approve, and the resume prompt work end to end |
| Package install | `pi install <dir>` followed by a fresh session discovers `/idcoder` and `skill:idcoder` (checked manually) |
| Not exercised | The optional `@huggingface/transformers` backend with a real model download (its adapter is unit-tested through an injected loader); themes and narrow widths in a real terminal beyond the smoke path; clicking through the browser viewer; Windows |

## Writing new tests

| Need | Use |
|---|---|
| One stage, specific branches | `makeContext` + `ScriptedLlm` (`test/helpers/harness.ts`, `fake-llm.ts`) |
| Whole pipeline offline | `RunSession` + `SimulatedGateway` + `HashingEmbedder` + `writeCorpus(gameReviews())` |
| Teach the simulator a new prompt | Add a marker to `SKILL_MARKERS` and a case to `simulate()` in `simulated-llm.ts` |
| UI flows | `FakeUi` (`test/helpers/fake-ui.ts`); it enforces the width contract on every render |
| Tools and commands | `FakePi` + `fakeContext` (`test/helpers/fake-pi.ts`) with `registerIdcoder(..., overrides)` |
| Real pi | `PiRpc` + `MockOpenAI` (`test/helpers/pi-rpc.ts`, `mock-openai.ts`) |
| A new oracle | Extend `test/fixtures/reference/generate.py` and commit its output |

**When you change a prompt.** The golden test fails by design. Decide whether the change is intended. If it is, update the golden through `generate.py` only if the Python source changed. Otherwise move that case out of the golden list and pin the new text with its own test, so the divergence from the original stays visible.
