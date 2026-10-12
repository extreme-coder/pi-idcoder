import { createHash } from "node:crypto";
import type { CodesOnlyFile, ReviewCodes } from "../artifacts/types.ts";
import type { IdcoderConfig } from "../config/schema.ts";
import { mapConcurrent } from "../core/concurrency.ts";
import { appendJsonl, readJsonl } from "../core/fs.ts";
import { removeThinkTags } from "../core/json.ts";
import { extractCodes } from "../core/text.ts";
import type { CorpusDocument } from "../corpus/load.ts";
import type { LlmClient } from "../llm/types.ts";
import { done, type Stage } from "../pipeline/stage.ts";
import { openCodingPrompt, validateOpenCodesPrompt } from "../prompts/pipeline.ts";

export const EMPTY_OUTPUT_PLACEHOLDER = `- Applicability: NONE
  Reason: Coder returned no text; cannot validate substantive codes.
  Evidence: "(empty output)"
`;

export interface Validation {
	verdict: "PASS" | "FAIL";
	feedback: string;
}

export function parseValidation(output: string): Validation {
	const feedback = output.trim();
	return { verdict: feedback.toUpperCase().startsWith("PASS") ? "PASS" : "FAIL", feedback };
}

export interface CodedDocument {
	review_id: number;
	text_hash: string;
	output: string;
	attempts: number;
	validation?: "PASS" | "FAIL";
}

export function textHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Codes one document; with the validator enabled, a FAIL triggers a revision that sees the
 * validator's issues, up to `maxRetries` revisions (the last attempt is kept either way).
 */
export async function codeDocument(
	llm: LlmClient,
	researchQuestion: string,
	doc: CorpusDocument,
	settings: IdcoderConfig["openCoding"],
	signal?: AbortSignal,
): Promise<CodedDocument> {
	let feedback: string | undefined;
	let output = "";
	let validation: Validation | undefined;
	let attempts = 0;
	for (;;) {
		attempts++;
		const response = await llm.complete({
			skill: "open_coding",
			prompt: openCodingPrompt(researchQuestion, doc.text, feedback),
			role: "coder",
			labels: { review_id: doc.reviewId, attempt: attempts },
			signal,
		});
		output = removeThinkTags(response.text);
		if (!output.trim()) output = EMPTY_OUTPUT_PLACEHOLDER;
		if (!settings.validator) break;
		const check = await llm.complete({
			skill: "validate_open_codes",
			prompt: validateOpenCodesPrompt(researchQuestion, doc.text, output),
			role: "validator",
			labels: { review_id: doc.reviewId, attempt: attempts },
			signal,
		});
		validation = parseValidation(removeThinkTags(check.text));
		if (validation.verdict === "PASS" || attempts > settings.maxRetries) break;
		feedback = validation.feedback;
	}
	return {
		review_id: doc.reviewId,
		text_hash: textHash(doc.text),
		output,
		attempts,
		...(validation ? { validation: validation.verdict } : {}),
	};
}

export function renderOpenCodesMarkdown(coded: readonly CodedDocument[]): string {
	return coded.map((c) => `## Review ${c.review_id}\n\n${c.output}\n\n`).join("");
}

export function codesOnlyFromCoded(coded: readonly CodedDocument[]): CodesOnlyFile {
	const perReview: ReviewCodes[] = coded.map((c) => [c.review_id, extractCodes(c.output)]);
	return { all_codes: perReview.flatMap(([, codes]) => codes), codes_per_review: perReview };
}

export const openCodingStage: Stage = {
	id: "open_coding",
	title: "Open coding",
	enabled: () => true,
	checkpoints: (paths) => [paths.openCodingCheckpoint],
	async run(ctx) {
		const docs = await ctx.corpus();
		const settings = ctx.config.openCoding;
		const rq = ctx.config.study.researchQuestion;

		const checkpoint = new Map<number, CodedDocument>();
		for (const row of await readJsonl<CodedDocument>(ctx.paths.openCodingCheckpoint)) {
			checkpoint.set(row.review_id, row);
		}
		const pending = docs.filter((d) => checkpoint.get(d.reviewId)?.text_hash !== textHash(d.text));
		ctx.logger.info(
			"OPEN_CODING",
			`${docs.length} documents, ${docs.length - pending.length} restored from checkpoint, validator ${settings.validator ? "on" : "off"}`,
		);

		let finished = docs.length - pending.length;
		ctx.progress({ done: finished, total: docs.length });
		await mapConcurrent(pending, settings.workers, (doc) => codeDocument(ctx.llm, rq, doc, settings, ctx.signal), {
			signal: ctx.signal,
			onResult: async (coded) => {
				checkpoint.set(coded.review_id, coded);
				await appendJsonl(ctx.paths.openCodingCheckpoint, coded);
				ctx.progress({ done: ++finished, total: docs.length, message: `review ${coded.review_id}` });
			},
		});

		const coded = docs.map((d) => checkpoint.get(d.reviewId)!);
		await ctx.store.writeOpenCodesMarkdown(renderOpenCodesMarkdown(coded));
		const codesOnly = codesOnlyFromCoded(coded);
		await ctx.store.writeCodesOnly(codesOnly);

		const abstained = coded.filter((c) => extractCodes(c.output).length === 0).length;
		const failedValidation = coded.filter((c) => c.validation === "FAIL").length;
		ctx.logger.info(
			"CODES_EXTRACTED",
			`Total codes: ${codesOnly.all_codes.length} (from ${coded.length} reviews; ${abstained} abstained)`,
		);
		return done(`${codesOnly.all_codes.length} codes from ${coded.length} documents (${abstained} abstained)`, {
			codes: codesOnly.all_codes.length,
			documents: coded.length,
			abstained,
			...(settings.validator ? { failed_validation: failedValidation } : {}),
		});
	},
};
