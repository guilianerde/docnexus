/** Preserve input order and drain started work before returning or throwing. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failures: Array<{ index: number; reason: unknown }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failures.length && next < items.length) {
      const index = next++;
      try { results[index] = await map(items[index], index); }
      catch (reason) { failures.push({ index, reason }); }
    }
  }));
  if (failures.length) throw failures.sort((a, b) => a.index - b.index)[0].reason;
  return results;
}
