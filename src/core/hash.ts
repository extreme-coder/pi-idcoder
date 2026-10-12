import { createHash } from "node:crypto";

/** Short stable digest of JSON-serializable parts, used to key checkpoints to their inputs. */
export function fingerprint(...parts: unknown[]): string {
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}
