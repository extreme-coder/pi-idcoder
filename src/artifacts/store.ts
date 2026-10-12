import { fileExists, readJson, readJsonIfExists, readText, writeJson, writeTextAtomic } from "../core/fs.ts";
import type { RunPaths } from "./paths.ts";
import type {
	ClusteredCodesFile,
	CodebookConfidenceFile,
	CodebookFile,
	CodebookProvenanceFile,
	CodesOnlyFile,
	DimensionsEnrichedFile,
	GlobalGraphFile,
	HierarchyFile,
	MetaThemesFile,
} from "./types.ts";

export class MissingArtifactError extends Error {
	constructor(what: string, producer: string) {
		super(`Missing ${what}; run the ${producer} stage first.`);
		this.name = "MissingArtifactError";
	}
}

/** Typed access to one run's artifacts. */
export class ArtifactStore {
	readonly paths: RunPaths;

	constructor(paths: RunPaths) {
		this.paths = paths;
	}

	private async require<T>(path: string, what: string, producer: string): Promise<T> {
		if (!(await fileExists(path))) throw new MissingArtifactError(what, producer);
		return readJson<T>(path);
	}

	codesOnly(): Promise<CodesOnlyFile> {
		return this.require(this.paths.codesOnly, "gt_codes_only.json", "open_coding");
	}
	writeCodesOnly(data: CodesOnlyFile): Promise<void> {
		return writeJson(this.paths.codesOnly, data);
	}

	async openCodesMarkdown(): Promise<string> {
		if (!(await fileExists(this.paths.openCodesMarkdown))) {
			throw new MissingArtifactError("gt_open_codes_all_reviews.md", "open_coding");
		}
		return readText(this.paths.openCodesMarkdown);
	}
	writeOpenCodesMarkdown(markdown: string): Promise<void> {
		return writeTextAtomic(this.paths.openCodesMarkdown, markdown);
	}

	clustered(): Promise<ClusteredCodesFile> {
		return this.require(this.paths.clusteredCodes, "gt_clustered_codes.json", "axial_clustering");
	}
	writeClustered(data: ClusteredCodesFile): Promise<void> {
		return writeJson(this.paths.clusteredCodes, data);
	}

	codebook(): Promise<CodebookFile> {
		return this.require(this.paths.codebook, "codebook.json", "cluster_labeling");
	}
	codebookIfExists(): Promise<CodebookFile | undefined> {
		return readJsonIfExists(this.paths.codebook);
	}
	writeCodebook(data: CodebookFile): Promise<void> {
		return writeJson(this.paths.codebook, data);
	}

	async confidence(): Promise<CodebookConfidenceFile> {
		return (await readJsonIfExists<CodebookConfidenceFile>(this.paths.codebookConfidence)) ?? {};
	}
	writeConfidence(data: CodebookConfidenceFile): Promise<void> {
		return writeJson(this.paths.codebookConfidence, data);
	}

	provenance(): Promise<CodebookProvenanceFile | undefined> {
		return readJsonIfExists(this.paths.codebookProvenance);
	}
	writeProvenance(data: CodebookProvenanceFile): Promise<void> {
		return writeJson(this.paths.codebookProvenance, data);
	}

	hierarchy(): Promise<HierarchyFile> {
		return this.require(this.paths.hierarchy, "gt_hierarchy.json", "hierarchy");
	}
	async hierarchyIfExists(): Promise<HierarchyFile | undefined> {
		return readJsonIfExists(this.paths.hierarchy);
	}
	writeHierarchy(data: HierarchyFile): Promise<void> {
		return writeJson(this.paths.hierarchy, data);
	}

	metaThemes(): Promise<MetaThemesFile> {
		return this.require(this.paths.metaThemes, "gt_meta_themes.json", "meta_themes");
	}
	writeMetaThemes(data: MetaThemesFile): Promise<void> {
		return writeJson(this.paths.metaThemes, data);
	}

	dimensionsPath(evidence: "sampled" | "full"): string {
		return evidence === "full" ? this.paths.metaThemesEnrichedFull : this.paths.metaThemesEnriched;
	}
	dimensions(evidence: "sampled" | "full"): Promise<DimensionsEnrichedFile> {
		return this.require(this.dimensionsPath(evidence), "enriched meta-themes", "dimension_enrichment");
	}
	writeDimensions(evidence: "sampled" | "full", data: DimensionsEnrichedFile): Promise<void> {
		return writeJson(this.dimensionsPath(evidence), data);
	}

	globalGraph(): Promise<GlobalGraphFile> {
		return this.require(this.paths.globalGraph, "gt_global_graph.json", "tree_assembly");
	}
	writeGlobalGraph(data: GlobalGraphFile): Promise<void> {
		return writeJson(this.paths.globalGraph, data);
	}
}
