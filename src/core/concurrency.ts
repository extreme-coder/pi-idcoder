export class AbortedError extends Error {
	constructor(message = "Operation aborted") {
		super(message);
		this.name = "AbortedError";
	}
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortedError();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new AbortedError());
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new AbortedError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export interface MapOptions<R> {
	signal?: AbortSignal;
	/** Called as each item finishes, in completion order (for incremental checkpoints and progress). */
	onResult?: (result: R, index: number) => void | Promise<void>;
}

/**
 * Maps items through `fn` with at most `limit` in flight, preserving input order in the result.
 * The first rejection stops scheduling new work and is rethrown once in-flight work settles.
 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
	options: MapOptions<R> = {},
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failure: unknown;
	let failed = false;

	const worker = async (): Promise<void> => {
		while (!failed) {
			if (options.signal?.aborted) {
				failed = true;
				failure ??= new AbortedError();
				return;
			}
			const index = next++;
			if (index >= items.length) return;
			try {
				const result = await fn(items[index]!, index);
				results[index] = result;
				await options.onResult?.(result, index);
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
	};

	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
	await Promise.all(workers);
	if (failed) throw failure;
	return results;
}
