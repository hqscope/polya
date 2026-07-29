// Reciprocal Rank Fusion — port of the extension's SemanticMatcher.rrfMerge
// (extension-core/src/core/semantic-matcher.js). Pure module: no runtime globals.

export const RRF_K = 60;

export function rrfMerge<T>(
  listA: readonly T[],
  listB: readonly T[],
  idExtractor: (item: T) => string,
  k: number = RRF_K,
  weightOf?: (item: T) => number,
): T[] {
  const scores = new Map<string, number>();
  const itemMap = new Map<string, T>();

  const processList = (list: readonly T[]) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, index) => {
      const id = idExtractor(item);
      const rank = index + 1;
      const weight = weightOf ? weightOf(item) : 1;
      const score = weight / (k + rank);

      scores.set(id, (scores.get(id) || 0) + score);
      itemMap.set(id, item);
    });
  };

  processList(listA);
  processList(listB);

  const sortedIds = Array.from(scores.keys()).sort(
    (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
  );

  return sortedIds.map((id) => itemMap.get(id) as T);
}
