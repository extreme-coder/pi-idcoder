---
name: idcoder
description: Inductive-deductive qualitative coding (thematic analysis) of a text corpus with ID-Coder — open coding, clustering, a human codebook review gate, enrichment, meta-themes, a research report, then deductive recoding with Krippendorff's alpha and blind LLM/human judging. Use when the user wants to code survey responses, reviews, interviews, or posts into themes, build or audit a codebook, or evaluate how reliably a codebook can be reapplied.
---

# ID-Coder

ID-Coder runs in two halves. The **inductive agent** builds a codebook from the corpus. The **deductive agents** recode the corpus using only that codebook, which shows how reliably it can be reapplied.

## Before running

1. Check for `.idcoder/config.json`. If it is missing, ask the user to run `/idcoder init`, or write one yourself. The config needs a `study` (research question and corpus path), `models.coder`, and `embeddings`. Prefer the user's existing provider. Never invent API keys.
2. Corpora can be CSV (`text_review`, `review_text`, or `text` column), JSONL, or TXT (one document per line).
3. Call `idcoder_status` to see which stages are done. Runs resume from checkpoints, so re-running is cheap.

## Running

- `idcoder_run` resumes the pipeline from the first unfinished stage.
- It **pauses at the codebook review gate** unless `review.enabled` is false. When it pauses, stop and tell the user to review with `/idcoder review` (terminal) or `/idcoder viewer` (browser), then resume. **Never approve, rename, merge, or drop clusters on the user's behalf.** The paper requires that this step stays under expert control.
- Pass `from` only when the user wants a stage recomputed, for example after changing a model or prompt. It discards that stage and everything after it.
- If a stage fails, report the error. Successful work is checkpointed, so `idcoder_run` retries from the failed stage.

## Answering questions about results

Use `idcoder_inspect` instead of reading raw files:

| `what` | Shows |
|---|---|
| `codebook` | Every cluster with its size, confidence, provenance, and definition |
| `cluster` + `cluster_id` | Definition, inclusion/exclusion criteria with grounded quotes, and codes |
| `meta_themes` | Meta-themes with their definitions and member clusters |
| `report` | The research report answering the research question |
| `evaluation` | Agreement and judge summary |
| `usage` | LLM calls, tokens, and cost by stage, skill, and model |

Quote the corpus only through the grounded examples. Do not paraphrase them as if they were quotes.

## Evaluating

`idcoder_evaluate` needs a completed run with enrichment enabled.

1. Deductive agents (`models.deductive`, defaulting to the coder) recode every quote at the codebook detail levels in `evaluation.levels`.
2. Krippendorff's alpha compares them with the inductive assignments. Report alpha per level.
3. Disagreements become blind A/B items. Each judge in `models.judges` picks *prefer A*, *prefer B*, *both fit*, or *neither fits*.
4. Human annotators judge the same items with `/idcoder judge <annotator>`. Their judgments are included in the summary.

When interpreting results, low alpha suggests codebook boundaries that do not transfer. A judge preference for the deductive assignment suggests the inductive clustering misplaced those quotes. The paper also finds that human judges agree with each other far less than LLM judges do.
