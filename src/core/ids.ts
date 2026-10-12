const DIGITS = /^\d+$/;

/** Orders cluster ids numerically when both are integers, otherwise numeric ids first then lexically. */
export function compareClusterIds(a: string, b: string): number {
	const aNum = DIGITS.test(a);
	const bNum = DIGITS.test(b);
	if (aNum && bNum) return Number(a) - Number(b);
	if (aNum !== bNum) return aNum ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

export function sortClusterIds(ids: Iterable<string>): string[] {
	return [...ids].sort(compareClusterIds);
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}

/** Cluster-local code id used in enrichment prompts (`LC001`), 1-based. */
export function localCodeId(index: number): string {
	return `LC${pad(index + 1, 3)}`;
}

/** Stable corpus-wide open code id (`OC001`), 1-based. */
export function openCodeId(index: number): string {
	return `OC${pad(index + 1, 3)}`;
}

export function snippetId(ordinal: number): string {
	return `SNIP-${pad(ordinal, 4)}`;
}

/** Cluster tag used in dimension enrichment prompts (`CL05`). */
export function clusterTag(clusterId: string): string {
	return `CL${clusterId.padStart(2, "0")}`;
}

export function rawClusterId(tag: string): string {
	return tag.startsWith("CL") && DIGITS.test(tag.slice(2)) ? String(Number(tag.slice(2))) : tag;
}

export function optionLetter(index: number): string {
	return String.fromCharCode("A".charCodeAt(0) + index);
}
