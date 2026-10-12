import type { ClusterToCodes, ProvenanceSource } from "../artifacts/types.ts";
import { sortClusterIds } from "../core/ids.ts";
import { CodebookReviewError } from "./apply.ts";
import { type ClusterEntry, defaultClusterEntry, type EnrichedCodebook, type ReviewOperation } from "./schema.ts";

export interface ClusterView {
	id: string;
	entry: ClusterEntry;
	codes: readonly string[];
}

interface Snapshot {
	clusters: Record<string, ClusterEntry>;
	clusterToCodes: ClusterToCodes;
	operations: ReviewOperation[];
}

function operationClusterIds(op: ReviewOperation): string[] {
	if (op.type === "merge") return [...(op.from_cluster_ids ?? []), op.target_cluster_id];
	if (op.type === "split") return [op.from_cluster_id, ...(op.splits ?? []).map((p) => p.new_cluster_id)];
	return [op.cluster_id];
}

function edited(source: ProvenanceSource): ProvenanceSource {
	return source === "llm" ? "llm+edited" : source;
}

function normalizeEntry(id: string, entry: Partial<ClusterEntry> | undefined): ClusterEntry {
	return {
		...defaultClusterEntry(entry?.label || `Cluster ${id}`),
		...entry,
	} as ClusterEntry;
}

/**
 * Editable review state (paper §3.1: rename labels, reassign codes, split or merge clusters,
 * remove clusters, flag for more evidence). Membership in `clusterToCodes` is always final;
 * `operations` is the audit log the viewer format expects. Every edit is undoable.
 */
export class ReviewSession {
	private clusters: Record<string, ClusterEntry>;
	private clusterToCodes: ClusterToCodes;
	private operations: ReviewOperation[];
	private readonly history: Snapshot[] = [];
	/** Ids are never reused: a recycled id would make the operation log ambiguous. */
	private idCounter: number;

	constructor(payload: EnrichedCodebook) {
		const ids = new Set([...Object.keys(payload.cluster_to_codes ?? {}), ...Object.keys(payload.clusters ?? {})]);
		this.clusters = Object.fromEntries([...ids].map((id) => [id, normalizeEntry(id, payload.clusters?.[id])]));
		this.clusterToCodes = Object.fromEntries([...ids].map((id) => [id, [...(payload.cluster_to_codes?.[id] ?? [])]]));
		this.operations = [...(payload.operations ?? [])];
		const seen = [...ids, ...this.operations.flatMap(operationClusterIds)].filter((id) => /^\d+$/.test(id));
		this.idCounter = seen.length ? Math.max(...seen.map(Number)) + 1 : 0;
	}

	get canUndo(): boolean {
		return this.history.length > 0;
	}

	get editCount(): number {
		return this.history.length;
	}

	/** Kept clusters, least confident first so the reviewer starts with what most needs attention. */
	list(): ClusterView[] {
		return sortClusterIds(Object.keys(this.clusters))
			.map((id) => ({ id, entry: this.clusters[id]!, codes: this.clusterToCodes[id] ?? [] }))
			.sort((a, b) => {
				const dropped = Number(a.entry.status === "drop") - Number(b.entry.status === "drop");
				return dropped || a.entry.confidence - b.entry.confidence;
			});
	}

	get(id: string): ClusterView {
		const entry = this.clusters[id];
		if (!entry) throw new CodebookReviewError(`Unknown cluster ${id}`);
		return { id, entry, codes: this.clusterToCodes[id] ?? [] };
	}

	clusterOf(code: string): string | undefined {
		return Object.keys(this.clusterToCodes).find((id) => this.clusterToCodes[id]!.includes(code));
	}

	private checkpoint(): void {
		this.history.push(
			structuredClone({ clusters: this.clusters, clusterToCodes: this.clusterToCodes, operations: this.operations }),
		);
	}

	undo(): boolean {
		const previous = this.history.pop();
		if (!previous) return false;
		this.clusters = previous.clusters;
		this.clusterToCodes = previous.clusterToCodes;
		this.operations = previous.operations;
		return true;
	}

	private nextId(): string {
		return String(this.idCounter++);
	}

	private requireKept(id: string): ClusterEntry {
		const entry = this.get(id).entry;
		if (entry.status === "drop") throw new CodebookReviewError(`Cluster ${id} is dropped; restore it first.`);
		return entry;
	}

	rename(id: string, label: string): void {
		const trimmed = label.trim();
		if (!trimmed) throw new CodebookReviewError("Label cannot be empty.");
		const entry = this.requireKept(id);
		if (trimmed === entry.label) return;
		this.checkpoint();
		this.clusters[id] = { ...entry, label: trimmed, source: edited(entry.source) };
	}

	describe(id: string, description: string): void {
		const entry = this.requireKept(id);
		if (description === entry.description) return;
		this.checkpoint();
		this.clusters[id] = { ...entry, description, source: edited(entry.source) };
	}

	toggleNeedsEvidence(id: string): void {
		const entry = this.get(id).entry;
		this.checkpoint();
		this.clusters[id] = { ...entry, needs_more_evidence: !entry.needs_more_evidence };
	}

	private ownersOf(codes: readonly string[]): string[] {
		return codes.map((code) => {
			const owner = this.clusterOf(code);
			if (owner === undefined) throw new CodebookReviewError(`Code ${JSON.stringify(code)} is not in any cluster.`);
			return owner;
		});
	}

	moveCodes(codes: readonly string[], targetId: string): void {
		this.requireKept(targetId);
		if (codes.length === 0) return;
		const owners = this.ownersOf(codes);
		this.checkpoint();
		this.moveInto(codes, owners, targetId);
	}

	private moveInto(codes: readonly string[], owners: readonly string[], targetId: string): void {
		codes.forEach((code, i) => {
			const owner = owners[i]!;
			if (owner === targetId) return;
			this.clusterToCodes[owner] = this.clusterToCodes[owner]!.filter((c) => c !== code);
			this.clusterToCodes[targetId] = [...this.clusterToCodes[targetId]!, code];
			for (const id of [owner, targetId]) {
				this.clusters[id] = { ...this.clusters[id]!, source: edited(this.clusters[id]!.source) };
			}
		});
	}

	merge(sourceIds: readonly string[], targetId: string, label?: string): void {
		const others = [...new Set(sourceIds)].filter((id) => id !== targetId);
		if (others.length === 0) throw new CodebookReviewError("Select at least one other cluster to merge.");
		for (const id of [targetId, ...others]) this.requireKept(id);
		this.checkpoint();
		const target = this.clusters[targetId]!;
		this.clusterToCodes[targetId] = [
			...this.clusterToCodes[targetId]!,
			...others.flatMap((id) => this.clusterToCodes[id] ?? []),
		];
		for (const id of others) {
			delete this.clusterToCodes[id];
			delete this.clusters[id];
		}
		const newLabel = label?.trim() || target.label;
		this.clusters[targetId] = {
			...target,
			label: newLabel,
			source: newLabel !== target.label ? "human" : edited(target.source),
			confidence: Math.max(target.confidence, 1),
		};
		this.operations.push({
			type: "merge",
			from_cluster_ids: [targetId, ...others],
			target_cluster_id: targetId,
			label: newLabel,
		});
	}

	/** Splits the selected codes out of a cluster into a new human-authored cluster. */
	split(id: string, codes: readonly string[], label: string): string {
		const entry = this.requireKept(id);
		const current = this.clusterToCodes[id] ?? [];
		const moving = [...new Set(codes)];
		if (moving.length === 0) throw new CodebookReviewError("Select at least one code to split out.");
		if (moving.length === current.length)
			throw new CodebookReviewError("A split must leave codes in the original cluster.");
		for (const code of moving) {
			if (!current.includes(code))
				throw new CodebookReviewError(`Code ${JSON.stringify(code)} is not in cluster ${id}.`);
		}
		const trimmed = label.trim();
		if (!trimmed) throw new CodebookReviewError("New cluster needs a label.");
		this.checkpoint();
		const keepId = this.nextId();
		this.clusters[keepId] = { ...entry, source: edited(entry.source) };
		this.clusterToCodes[keepId] = current.filter((c) => !moving.includes(c));
		const newId = this.nextId();
		this.clusters[newId] = defaultClusterEntry(trimmed, { source: "human", confidence: entry.confidence });
		this.clusterToCodes[newId] = moving;
		delete this.clusters[id];
		delete this.clusterToCodes[id];
		this.operations.push({
			type: "split",
			from_cluster_id: id,
			splits: [
				{ new_cluster_id: keepId, label: entry.label, code_ids: [...this.clusterToCodes[keepId]!] },
				{ new_cluster_id: newId, label: trimmed, code_ids: moving },
			],
		});
		return newId;
	}

	/** Marks a cluster dropped; its codes are deleted or kept as orphans when the review is applied. */
	drop(id: string, disposition: "delete" | "orphan"): void {
		const entry = this.requireKept(id);
		this.checkpoint();
		this.clusters[id] = { ...entry, status: "drop" };
		this.operations.push({ type: "drop", cluster_id: id, code_disposition: disposition });
	}

	restore(id: string): void {
		const entry = this.get(id).entry;
		if (entry.status !== "drop") return;
		this.checkpoint();
		this.clusters[id] = { ...entry, status: "keep" };
		this.operations = this.operations.filter((op) => !(op.type === "drop" && op.cluster_id === id));
	}

	create(label: string, codes: readonly string[]): string {
		const trimmed = label.trim();
		if (!trimmed) throw new CodebookReviewError("New cluster needs a label.");
		const owners = this.ownersOf(codes);
		const id = this.nextId();
		this.checkpoint();
		this.clusters[id] = defaultClusterEntry(trimmed, { source: "human", confidence: 5 });
		this.clusterToCodes[id] = [];
		this.moveInto(codes, owners, id);
		return id;
	}

	stats(): { kept: number; dropped: number; edited: number; flagged: number; lowConfidence: number } {
		const entries = Object.values(this.clusters);
		return {
			kept: entries.filter((e) => e.status !== "drop").length,
			dropped: entries.filter((e) => e.status === "drop").length,
			edited: entries.filter((e) => e.source !== "llm").length,
			flagged: entries.filter((e) => e.needs_more_evidence).length,
			lowConfidence: entries.filter((e) => e.status !== "drop" && e.confidence <= 2).length,
		};
	}

	toPayload(): EnrichedCodebook {
		return structuredClone({
			version: 2,
			clusters: this.clusters,
			operations: this.operations,
			cluster_to_codes: this.clusterToCodes,
		});
	}
}
