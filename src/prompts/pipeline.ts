/**
 * Prompt templates for the inductive pipeline, ported verbatim from the original implementation
 * (agents/core/prompts.py and the inline prompts in tools.py / enrichment modules).
 */

export function openCodingPrompt(researchQuestion: string, text: string, validatorFeedback?: string): string {
	const feedbackSection = validatorFeedback
		? `
A reviewer found issues with the previous codes. Use this feedback to improve:
${validatorFeedback}

Revise your codes accordingly. Output the same format as below.
`
		: "";
	return `
You are doing Open Coding for thematic analysis on ONE user review.

Research Question: ${researchQuestion}
Focus on aspects of the review that are relevant to the research question above.

Rules:
- Produce **0 to 3** codes, depending on whether the review actually offers material that **answers the research question**.
- If the review is **off-topic**, **too thin**, or contains **nothing** that bears on the question (e.g. the question asks for negative feedback and the review only gives generic praise with no relevant substance), you must **not** invent codes — use the **Applicability: NONE** format below instead.
- When the review **does** contain relevant material, produce 1–3 codes (up to 2 for short reviews under ~50 words unless clearly richer).
- Each code must be a short noun phrase (2–6 words).
- Codes must be distinct (no near-duplicates).
- Each code must name a specific aspect AND its quality or direction — not just a neutral topic.
  Good: "laggy multiplayer matchmaking", "intuitive inventory controls", "frustrating difficulty spike"
  Bad: "matchmaking", "controls", "difficulty"
- Codes must be grounded in the review text — do not invent concepts not present.
${feedbackSection}

When there is **nothing** to code for this research question, output **exactly** (no \`- Code:\` lines):

- Applicability: NONE
  Reason: <one or two sentences explaining why no code is appropriate>
  Evidence: "<short quote from the review, or state that the text does not address the question>"

When there **is** relevant material, output one block per code (no Applicability line):

- Code: <code>
  Evidence: "<short quote from the review>"
  Note: <one short phrase why this code fits>

Review:
${text}
`;
}

export function validateOpenCodesPrompt(researchQuestion: string, text: string, generatedCodes: string): string {
	return `You are reviewing qualitative codes generated from user feedback for a research question.

Research Question: ${researchQuestion}

Input text (the review):
${text}

Coder output:
${generatedCodes}

First, determine whether the coder claimed **no applicable codes** (e.g. \`- Applicability: NONE\` and **no** lines of the form \`- Code: ...\`).

If **no codes** were claimed:
- PASS only if the review truly has **no** usable, question-relevant content to code (off-topic, empty of substance for the question, or praise/generic text that does not bear on what was asked). The Reason/Evidence should be accurate.
- FAIL if the review **does** contain material that should have been coded, or if the justification is wrong or evasive.

If **one or more** \`- Code:\` lines are present:
1. Codes are grounded in the data (evidence in the review supports each code).
2. Codes are not duplicates or near-duplicates of each other.
3. Codes are concise concepts (short noun phrases, not vague or hallucinated).
4. Codes are evaluatively specific — each names a concrete aspect AND its quality or
   direction (e.g. "poor enemy AI behaviour", not just "enemy AI").
   A code that is a neutral topic label with no direction should be flagged as FAIL.
5. Each code is **relevant to the research question**; FAIL if a code is forced or tangential when the review does not support it.

If the output mixes \`- Applicability: NONE\` with \`- Code:\` lines, or is empty, FAIL.

Respond with exactly one of:
- PASS
or
- FAIL
Issues:
- <first issue>
- <second issue>
...

If PASS, you may add a single line of explanation after PASS. If FAIL, list specific issues so the coder can revise.`;
}

/** HICode's clustering system prompt; only the goal slot is filled with the research question. */
export function llmClusteringPrompt(researchQuestion: string): string {
	const goal = researchQuestion.trim() || "thematic patterns in the coded material";
	return `Synthesize the entire list of labels by clustering similar labels that are inductively labeled.
The clustering is to finalize MEANINGFUL and INSIGHTFUL THEMES for ${goal}
Output in json format where the key is the cluster, and the value is the list of input labels in that cluster.
For each cluster, the value should only take labels from the user input.
ONLY output the JSON object, and do not add any other text.`;
}

export function highLevelCodeGenerationPrompt(bulletedCodes: string, researchQuestion: string): string {
	const rqLine = researchQuestion
		? `\nResearch Question: ${researchQuestion}\nGenerate with the research question in mind.\n`
		: "";
	return `The following open codes belong to one cluster:

${bulletedCodes}
${rqLine}
Output a single JSON object with:
- "label": one short high-level label (2-6 words) for this cluster
- "confidence": integer 1-5 (5 = very coherent, 1 = low coherence)
- "rationale": one sentence explaining why the cluster coheres or doesn't

Output ONLY valid JSON, no other text. Example: {"label": "Interface usability issues", "confidence": 4, "rationale": "Codes all relate to UI and usability."}`;
}

export function highLevelSynthesisPrompt(candidateLabels: readonly string[], researchQuestion: string): string {
	const rqLine = researchQuestion ? `\nResearch Question: ${researchQuestion}\n` : "";
	const bulleted = candidateLabels.map((label) => `- ${label}`).join("\n");
	return `You are synthesizing multiple candidate labels for one cluster.
Each label was generated from a different random sample of open codes within the same cluster.
${rqLine}
Candidate labels:
${bulleted}

Produce a single final label that best captures the overall theme across all candidates.
If all candidates agree, confidence should be high (4-5).
If candidates diverge significantly, reflect that with a lower confidence score (1-2).

Output ONLY a single JSON object with keys: "label" (2-6 words), "confidence" (1-5), "rationale" (one sentence).
Example: {"label": "Interface usability issues", "confidence": 4, "rationale": "All candidates pointed to usability; minor variation in framing."}`;
}

export function refineClusterAssignmentsPrompt(label: string, bulletedCodes: string, otherLabels: string): string {
	return `You are reviewing the codes assigned to a cluster labeled "${label}".

Codes in this cluster:
${bulletedCodes}

The only permitted move targets are these clusters (at most five, chosen as the most similar to "${label}" by embedding — you may not suggest any other label):
${otherLabels}

A code should be moved ONLY if ALL of the following are true:
1. It shares zero conceptual overlap with "${label}" — not just a weaker fit, but genuinely no overlap.
2. It maps unambiguously to exactly one of the clusters listed above — not a toss-up between two.
3. You would bet confidently on this move; any doubt means leave it.

For each code that meets all three criteria, output exactly:
MOVE: "{code}" → "{target cluster label}"

If no codes meet all three criteria, output: NONE

Do not move codes that are borderline, tangentially related, or where you are choosing the "least bad" option from the list. When in doubt: NONE.`;
}

export function metaThemeGroupingPrompt(labelsJson: string, researchQuestion: string): string {
	const rqLine = researchQuestion
		? `\nResearch Question: ${researchQuestion}\nGroup with the research question in mind.\n`
		: "";
	return `You are organising the results of a thematic analysis into a high-level hierarchy.

Below is a JSON object mapping cluster IDs to their labels:

${labelsJson}
${rqLine}
Your task: group ALL of these clusters into a **small handful** of broad meta-themes.
- If there are **six or more** clusters, use about **3 to 7** meta-themes (not a rigid count — balance and coverage matter).
- If there are **fewer than six** clusters, use **2 to N** themes where N is the number of clusters (merge only when labels are truly redundant).
- With **one** cluster, use a single meta-theme.

Rules:
- Every cluster ID must appear in exactly one group — do not drop any.
- Each meta-theme name should be 2–6 words and broader/more abstract than any individual cluster label.
- Aim for roughly balanced groups (avoid putting most clusters in one group).
- If two cluster labels are near-synonyms, place them in the same group.

Output ONLY valid JSON in this exact format:
{"meta_themes": [
  {"name": "Meta-Theme Name", "cluster_ids": ["0", "3", "7"]},
  {"name": "Another Meta-Theme", "cluster_ids": ["1", "4"]},
  ...
]}`;
}

export function intraClusterSubthemePrompt(clusterLabel: string, codesList: string, researchQuestion: string): string {
	const rqLine = researchQuestion ? `\nResearch Question: ${researchQuestion}\n` : "";
	return `You are building a thematic hierarchy. The cluster below is labelled:
"${clusterLabel}"
${rqLine}
It contains these codes (one per line):
${codesList}

Your task: organise these codes into 2–5 sub-themes that are more specific than the cluster label.

Rules:
- Every code from the list above MUST appear in exactly one sub-theme OR in "ungrouped_codes".
- Prefer **named sub-themes** for almost every code: keep "ungrouped_codes" **empty or as small as possible** — use it only when a code truly fits no sub-theme.
- Add **enough** sub-themes so no single sub-theme carries an enormous list of codes (aim for roughly **≤ ~50 codes per sub-theme** when the batch is large).
- Sub-theme names should be 2–5 words, more specific than "${clusterLabel}".
- Do NOT invent codes that are not in the list above.
- Do NOT rename or alter any code — use the exact strings provided.

Output ONLY valid JSON:
{"sub_themes": [
  {"name": "Sub-Theme Name", "codes": ["code a", "code b"]},
  {"name": "Another Sub-Theme", "codes": ["code c"]}
], "ungrouped_codes": ["code d"]}`;
}

export function assignCodesToSubthemesPrompt(
	clusterLabel: string,
	subThemeNames: readonly string[],
	codes: readonly string[],
	researchQuestion: string,
): string {
	const stList = subThemeNames.map((name) => `- ${name}`).join("\n");
	const codesList = codes.map((c) => `- ${c}`).join("\n");
	const rqLine = researchQuestion ? `\nResearch Question: ${researchQuestion}\n` : "";
	return `Cluster: "${clusterLabel}"
${rqLine}
Existing sub-themes:
${stList}

Assign each of the following codes to **one** of the sub-themes above. Prefer a **best-fit** sub-theme for every code; use "unassigned" only for codes that genuinely fit **none** of the listed sub-themes (keep "unassigned" empty or tiny).

Codes:
${codesList}

Output ONLY valid JSON:
{"assignments": {"Sub-Theme Name": ["code a", "code b"], "Another Sub-Theme": ["code c"]}, "unassigned": ["code d"]}`;
}

export function hierarchyRefineBucketPrompt(
	clusterLabel: string,
	bucketLabel: string,
	codesBulleted: string,
	researchQuestion: string,
	numGroups: number,
): string {
	const rqLine = researchQuestion ? `\nResearch Question: ${researchQuestion}\n` : "";
	return `You are refining a thematic hierarchy for readability. Too many codes sit under one parent; split them into smaller groups.

Cluster (context): "${clusterLabel}"
Parent bucket to subdivide: "${bucketLabel}"
${rqLine}
The following codes must be partitioned into exactly ${numGroups} non-empty sub-groups. Each code appears in exactly one group.

Codes (use EXACT strings; do not rename or drop any):
${codesBulleted}

Rules:
- Output exactly ${numGroups} sub-themes in the JSON array.
- Each sub-theme has a short name (2–6 words) and a "codes" list.
- Every code from the list above must appear once across all groups.
- Balance sizes when possible (avoid one giant group and many tiny ones).

Output ONLY valid JSON:
{"sub_themes": [
  {"name": "Sub-group name", "codes": ["code a", "code b"]},
  ...
]}`;
}

export function researchReportPrompt(researchQuestion: string, graphText: string): string {
	return `You are a qualitative researcher. Your job is to **answer the research question** below using the thematic graph as evidence—not to describe or explain the graph as your main topic.

Research question:
${researchQuestion}

Below is a **thematic graph** as text: **nodes** (theme labels) and **edges** (parent → child relationships from the analysis pipeline). Treat it as the empirical backbone: only claim what these nodes and edges support. Do not invent themes or relations missing from the graph text.

Thematic graph:
${graphText}

Write your response in **markdown** with exactly these sections:

## Research question
Restate the research question in one sentence (you may quote it).

## Graph structure
One short line only: how many nodes and how many edges (or counts from the graph header). No thematic interpretation in this section.

## Research answer
**3–6 sentences** that **directly answer the research question** (e.g. how commenters frame severity, hope, denial, responsibility—whatever the question asks). Write about people, framings, and themes in the corpus. You may refer to specific theme names when helpful, but **avoid** opening with “the graph shows/reveals” and **avoid** narrating the graph structure (listing branches, saying “the graph is interconnected”) as a substitute for answering the question. If evidence is weak or ambiguous, note that briefly, then still answer with what the graph supports.

Do not output JSON. Do not add long bullet lists unless essential.`;
}

export function codebookEnrichmentPrompt(label: string, validIds: string, codesText: string): string {
	return `Theme: ${label}
VALID Code IDs — use ONLY these, do not invent others: ${validIds}
Codes and participant quotes:
${codesText}`;
}

export function codebookBatchEnrichmentPrompt(label: string, validIds: string, codesText: string): string {
	return `Theme: ${label}
VALID Code IDs for this batch — use ONLY these: ${validIds}
Codes and participant quotes:
${codesText}

Based on these codes, identify:
1. definition_notes: key aspects of the theme these codes reveal
2. inclusion: criteria for what belongs under this theme (cite supporting code IDs)
3. exclusion: criteria for what does NOT belong here (cite supporting code IDs)
Focus on patterns within this batch only.`;
}

export function codebookSynthesisPrompt(
	label: string,
	validIds: string,
	codeCount: number,
	allLabels: string,
	batchSize: number,
	partialBlock: string,
): string {
	return `Theme: ${label}
VALID Code IDs — use ONLY these, do not invent others: ${validIds}

All ${codeCount} open codes in this cluster:
${allLabels}

Partial codebook entries from each batch (each generated from ~${batchSize} codes with full evidence):
${partialBlock}

Produce one final codebook entry by following these rules:
1. label: use the theme name as given above.
2. definition: synthesize a single coherent definition from the definition_notes across all batches. It must be operational — a coder should be able to apply it without ambiguity.
3. keywords: list key terms that characterise this theme.
4. inclusion: merge all inclusion criteria. If two criteria from different batches say the same thing, keep one. If they are genuinely distinct, keep both. Each criterion must cite at least one code_id from the valid list above.
5. exclusion: same merging rules as inclusion. Prioritise criteria that draw a clear boundary against adjacent themes — vague criteria that merely restate the definition should be dropped.
6. Never invent code IDs. If a criterion cannot be grounded in any valid code ID, drop it.`;
}

export function invalidIdsCorrection(badIds: readonly string[], validIds: string): string {
	return `\n\nCORRECTION: your previous response used non-existent IDs: ${[...badIds].sort().join(", ")}. Select ONLY from: ${validIds}.`;
}

export function dimensionEnrichmentPrompt(
	name: string,
	ownIds: string,
	allIds: string,
	quotesText: string,
	neighbourQuotes?: string,
): string {
	const base = `Dimension: ${name}
This dimension's Cluster IDs (use for inclusion): ${ownIds}
All available Cluster IDs (may use for exclusion boundary criteria): ${allIds}

Participant quotes by cluster (no labels — derive from the quotes):
${quotesText}`;
	if (neighbourQuotes === undefined) return base;
	return `${base}

ALL quotes from OTHER (neighboring) clusters, for grounding exclusion boundary criteria only -- these do NOT belong to this dimension:
${neighbourQuotes}`;
}

export function dimensionIdsCorrection(badIds: readonly string[], ownIds: string, allIds: string): string {
	return `\n\nCORRECTION: your previous response used these non-existent IDs: ${[...badIds].sort().join(", ")}. For inclusion use only: ${ownIds}. For exclusion use only: ${allIds}.`;
}

export function metaThemeCountReminder(lo: number, hi: number): string {
	return `\n\nIMPORTANT: You must output between ${lo} and ${hi} meta_themes (inclusive), each with a distinct name. Every cluster ID must appear exactly once.`;
}
