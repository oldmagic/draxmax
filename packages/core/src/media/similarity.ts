import { titleKey } from './parse-title.ts';

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of two titles on character bigrams (0–1), after normalisation. */
export function titleSimilarity(a: string, b: string): number {
  const x = titleKey(a).replace(/^the /, '');
  const y = titleKey(b).replace(/^the /, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = bigrams(x);
  const B = bigrams(y);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) ?? 0);
  const total =
    [...A.values()].reduce((s, n) => s + n, 0) + [...B.values()].reduce((s, n) => s + n, 0);
  return (2 * overlap) / total;
}

/** Best similarity of `title` against any of `candidates`. */
export function bestSimilarity(title: string, candidates: (string | null | undefined)[]): number {
  return Math.max(
    0,
    ...candidates.filter((c): c is string => !!c).map((c) => titleSimilarity(title, c)),
  );
}
