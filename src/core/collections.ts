/** Appends to the list stored under `key`, creating it on first use. */
export function appendTo<T>(record: Record<string, T[]>, key: string, ...items: T[]): void {
	const list = record[key];
	if (list) list.push(...items);
	else record[key] = [...items];
}

/** Adds `amount` to `record[outer][inner]`, creating the inner record on first use. */
export function addNested(
	record: Record<string, Record<string, number>>,
	outer: string,
	inner: string,
	amount: number,
): void {
	const row = record[outer] ?? {};
	row[inner] = (row[inner] ?? 0) + amount;
	record[outer] = row;
}
