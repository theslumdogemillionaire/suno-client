/**
 * Walk an endpoint paged by `?page=N`, yielding each item once.
 *
 * Several Suno lists page by number rather than by cursor, and none of them
 * says reliably when it is done: a total can be absent, or count items that
 * also appear elsewhere (a profile's pinned clips). So the walk ends on what a
 * page actually holds:
 *
 *   - an empty page;
 *   - a page that adds nothing new, which is also what a server ignoring
 *     `page` looks like, and the guard against walking it forever;
 *   - a short page, when the list has a known page size;
 *   - the total, when the list reports one;
 *   - `maxPages`, when the caller set one.
 */
export interface NumberedPage<T> {
  items: readonly T[];
  /** Items in the whole list, when the endpoint says. */
  total?: number | null | undefined;
}

export interface WalkOptions<T> {
  fetchPage: (page: number) => Promise<NumberedPage<T>>;
  /** Identity for deduplication. */
  keyOf: (item: T) => string;
  /** A page with fewer items than this is the last one. */
  pageSize?: number;
  maxPages?: number;
}

export async function* walkNumberedPages<T>(options: WalkOptions<T>): AsyncGenerator<T, void, undefined> {
  const seen = new Set<string>();
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await options.fetchPage(page);
    let added = 0;
    for (const item of items) {
      const key = options.keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      added += 1;
      yield item;
    }
    if (items.length === 0 || added === 0) return;
    if (options.pageSize !== undefined && items.length < options.pageSize) return;
    if (typeof total === 'number' && seen.size >= total) return;
  }
}
