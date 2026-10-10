import type { DownloadRule } from '@draxmax/shared';
import { parseRelease } from '../media/parse-title.ts';
import { matchesEpisodeFilter, matchesText, parseEpisodeFilter } from '../rss/rules.ts';
import type { SearchResult } from './sources.ts';

/** The show and season a rule's folder holds, inferred from the episodes in it. */
export interface Identity {
  key: string;
  title: string;
  season: number;
  anime: boolean;
}

/** Most common show/season among episode names (season packs and movies don't count). */
export function inferIdentity(names: string[]): Identity | null {
  const counts = new Map<string, { id: Identity; n: number; anime: number }>();
  for (const name of names) {
    const r = parseRelease(name);
    if (!r.key || r.season === undefined || r.episodes.length === 0) continue;
    const k = `${r.key}|${r.season}`;
    const c = counts.get(k) ?? {
      id: { key: r.key, title: r.title, season: r.season, anime: false },
      n: 0,
      anime: 0,
    };
    c.n++;
    if (r.anime) c.anime++;
    counts.set(k, c);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { ...best.id, anime: best.anime * 2 >= best.n } : null;
}

/** Episode numbers of `id` among release/file names. */
export function episodesOf(names: string[], id: Identity): Set<number> {
  const out = new Set<number>();
  for (const name of names) {
    const r = parseRelease(name);
    if (r.key === id.key && r.season === id.season) for (const e of r.episodes) out.add(e);
  }
  return out;
}

/** Same, from RSS history episode keys ("show|s2e5"). */
export function episodesFromKeys(keys: Iterable<string>, id: Identity): Set<number> {
  const out = new Set<number>();
  const prefix = `${id.key}|s${id.season}e`;
  for (const k of keys)
    if (k.startsWith(prefix)) {
      const n = Number(k.slice(prefix.length));
      if (Number.isInteger(n)) out.add(n);
    }
  return out;
}

/**
 * Search text for a rule: its first "must contain" alternative without wildcards and bare
 * resolutions (indexers match whole words, "720" wouldn't find "720p"; the rule's own filter
 * still checks it). Regex rules fall back to the show title and season.
 */
export function searchQuery(
  rule: Pick<DownloadRule, 'mustContain' | 'useRegex'> & { name?: string },
  id: Identity | null,
) {
  const first = rule.useRegex ? '' : (rule.mustContain.find((s) => s.trim()) ?? '');
  const words = (first.split('|')[0] ?? '')
    .replace(/[*?]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^\d{3,4}p?$/i.test(w));
  if (words.length) return words.join(' ');
  // Nothing on disk to name the show yet: the rule's own name is the best guess.
  if (!id) return (rule.name ?? '').trim();
  const season = id.season > 1 ? ` S${String(id.season).padStart(2, '0')}` : '';
  return id.anime && id.season > 1 ? `${id.title} S${id.season}` : `${id.title}${season}`;
}

export interface PlannedDownload {
  result: SearchResult;
  episodes: number[];
}

export interface Plan {
  /** Released episodes the sources know about (from the first owned episode on). */
  released: number[];
  missing: number[];
  downloads: PlannedDownload[];
  /** Missing episodes without an acceptable release. */
  unavailable: number[];
}

/**
 * Chooses releases for missing episodes. Only results that pass the rule's own filters and
 * are the same show and season are considered, and only episodes from the first one owned
 * onwards (earlier ones were probably watched and deleted) unless `fromStart` asks for the
 * whole season. A batch is taken only when every
 * episode in it is missing; otherwise single episodes with the most seeders win.
 */
export function planDownloads(
  results: SearchResult[],
  rule: Pick<DownloadRule, 'mustContain' | 'mustNotContain' | 'useRegex' | 'episodeFilter'>,
  id: Identity,
  have: Set<number>,
  opts: { minSeeders: number; fromStart?: boolean },
): Plan {
  const floor = !opts.fromStart && have.size ? Math.min(...have) : 1;
  const filter = rule.episodeFilter?.trim() ? parseEpisodeFilter(rule.episodeFilter) : null;
  const candidates = results.flatMap((result) => {
    const r = parseRelease(result.title);
    if (r.key !== id.key || r.season !== id.season || r.episodes.length === 0) return [];
    if (!matchesText(rule, result.title)) return [];
    if (filter && !matchesEpisodeFilter(filter, r)) return [];
    return [{ result, episodes: r.episodes.filter((e) => e >= floor), repack: r.repack }];
  });
  const released = [...new Set(candidates.flatMap((c) => c.episodes))].sort((a, b) => a - b);
  const missing = released.filter((e) => !have.has(e));
  const missingSet = new Set(missing);

  const usable = candidates
    .filter(
      (c) =>
        c.episodes.length > 0 &&
        c.episodes.every((e) => missingSet.has(e)) &&
        (c.result.seeders === null || c.result.seeders >= opts.minSeeders),
    )
    .sort(
      (a, b) =>
        b.episodes.length - a.episodes.length ||
        Number(b.repack) - Number(a.repack) ||
        (b.result.seeders ?? 0) - (a.result.seeders ?? 0),
    );
  const claimed = new Set<number>();
  const downloads: PlannedDownload[] = [];
  for (const c of usable) {
    if (c.episodes.some((e) => claimed.has(e))) continue;
    for (const e of c.episodes) claimed.add(e);
    downloads.push({ result: c.result, episodes: [...c.episodes].sort((a, b) => a - b) });
  }
  downloads.sort((a, b) => a.episodes[0]! - b.episodes[0]!);
  return { released, missing, downloads, unavailable: missing.filter((e) => !claimed.has(e)) };
}
