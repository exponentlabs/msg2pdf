import type { Rectangle } from '../../shared/studio';

/** Exact matching over fixed text fragments with bounded occurrences and linear span traversal. */
export function searchRegions(
  pages: { text: { text: string; rect: Rectangle }[] }[],
  phrase: string,
) {
  if (!phrase.trim() || phrase.length > 200)
    throw new Error('Enter a visible phrase of at most 200 characters.');
  const hits: { page: number; rect: Rectangle; text: string }[] = [];
  let occurrences = 0;
  for (const [page, value] of pages.entries()) {
    let offset = 0;
    const spans = value.text.map((item) => {
      const start = offset;
      offset += item.text.length + 1;
      return { ...item, start, end: offset - 1 };
    });
    const joined = value.text.map((item) => item.text).join(' ');
    const seen = new Set<number>();
    let from = 0;
    let first = 0;
    while (occurrences < 1000 && hits.length < 1000) {
      const at = joined.indexOf(phrase, from);
      if (at < 0) break;
      occurrences++;
      while (first < spans.length && (spans[first]?.end ?? 0) <= at) first++;
      for (let index = first; index < spans.length && hits.length < 1000; index++) {
        const item = spans[index];
        if (!item || item.start >= at + phrase.length) break;
        if (item.end > at && !seen.has(index)) {
          seen.add(index);
          hits.push({ page, rect: item.rect, text: item.text.slice(0, 200) });
        }
      }
      from = at + phrase.length;
    }
    if (occurrences >= 1000 || hits.length >= 1000) break;
  }
  return hits;
}
