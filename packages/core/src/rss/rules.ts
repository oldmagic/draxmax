import type { DownloadRule } from '@draxmax/shared';
import { episodeKeys, parseRelease, type ParsedRelease } from '../media/parse-title.ts';

/**
 * RSS download-rule engine (pure functions). Semantics follow qBittorrent where sensible:
 *
 * - `mustContain`: the article matches if ANY entry matches (empty list = match all).
 *   Wildcard mode: an entry's space-separated words must ALL appear; `*` and `?` are wildcards,
 *   and `|` separates alternatives within an entry. Regex mode: each entry is a case-insensitive regex.
 * - `mustNotContain`: rejects the article if ANY entry matches.
 * - `episodeFilter`: `1x2;3x5-10;4x1-5x3;6x8-` (single, range, cross-season range, open-ended,
 *   where open-ended also includes every later season).
 * - `smartEpisodeFilter`: skip episodes already downloaded by this rule (a REPACK/PROPER is
 *   allowed once over a non-repack).
 * - `ignoreSubsequentDays`: after a match, ignore further matches for N days.
 */

export interface EpisodeRange {
  fromSeason: number;
  fromEpisode: number;
  /** Inclusive; `null` = open-ended (this season onwards, forever). */
  toSeason: number | null;
  toEpisode: number | null;
}

export class RuleSyntaxError extends Error {}

function wildcardToRegex(word: string): RegExp {
  const escaped = word
    .replace(/[.+^${}()[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped, 'i');
}

function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    throw new RuleSyntaxError(`Invalid regular expression "${pattern}": ${(err as Error).message}`);
  }
}

/** Normalises separators so "Show.Name" matches the words "show name". */
function normalizeTitle(title: string): string {
  return title.replace(/[._]+/g, ' ');
}

function entryMatches(entry: string, title: string, useRegex: boolean): boolean {
  if (useRegex) return compileRegex(entry).test(title);
  const normalized = normalizeTitle(title);
  return entry
    .split('|')
    .map((alt) => alt.trim())
    .filter(Boolean)
    .some((alt) =>
      alt
        .split(/\s+/)
        .filter(Boolean)
        .every(
          (word) => wildcardToRegex(word).test(normalized) || wildcardToRegex(word).test(title),
        ),
    );
}

/** Text conditions only (must contain / must not contain). */
export function matchesText(
  rule: Pick<DownloadRule, 'mustContain' | 'mustNotContain' | 'useRegex'>,
  fullTitle: string,
): boolean {
  // Feed titles are untrusted; bounding their length bounds backtracking in user regexes.
  const title = fullTitle.slice(0, 1000);
  const contain = rule.mustContain.map((s) => s.trim()).filter(Boolean);
  const notContain = rule.mustNotContain.map((s) => s.trim()).filter(Boolean);
  if (contain.length > 0 && !contain.some((e) => entryMatches(e, title, rule.useRegex)))
    return false;
  if (notContain.some((e) => entryMatches(e, title, rule.useRegex))) return false;
  return true;
}

/** Throws {@link RuleSyntaxError} for invalid regexes or episode filters. */
export function validateRule(
  rule: Pick<DownloadRule, 'mustContain' | 'mustNotContain' | 'useRegex' | 'episodeFilter'>,
): void {
  if (rule.useRegex)
    [...rule.mustContain, ...rule.mustNotContain].filter((s) => s.trim()).forEach(compileRegex);
  if (rule.episodeFilter?.trim()) parseEpisodeFilter(rule.episodeFilter);
}

/** Parses qBittorrent-style episode filters. */
export function parseEpisodeFilter(filter: string): EpisodeRange[] {
  const parts = filter
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new RuleSyntaxError('Episode filter is empty');
  return parts.map((part) => {
    const m = /^(\d{1,3})x(\d{1,4})(?:(-)(?:(?:(\d{1,3})x)?(\d{1,4}))?)?$/i.exec(
      part.replace(/\s+/g, ''),
    );
    if (!m)
      throw new RuleSyntaxError(
        `Invalid episode filter "${part}" (expected e.g. 1x05, 1x05-12, 1x05-2x03 or 1x05-)`,
      );
    const fromSeason = Number(m[1]);
    const fromEpisode = Number(m[2]);
    if (!m[3]) return { fromSeason, fromEpisode, toSeason: fromSeason, toEpisode: fromEpisode };
    if (m[5] === undefined) return { fromSeason, fromEpisode, toSeason: null, toEpisode: null };
    const toSeason = m[4] !== undefined ? Number(m[4]) : fromSeason;
    const toEpisode = Number(m[5]);
    if (toSeason < fromSeason || (toSeason === fromSeason && toEpisode < fromEpisode)) {
      throw new RuleSyntaxError(`Episode range "${part}" ends before it starts`);
    }
    return { fromSeason, fromEpisode, toSeason, toEpisode };
  });
}

function inRange(r: EpisodeRange, season: number, episode: number): boolean {
  const after = season > r.fromSeason || (season === r.fromSeason && episode >= r.fromEpisode);
  if (!after) return false;
  if (r.toSeason === null) return true;
  return season < r.toSeason || (season === r.toSeason && episode <= (r.toEpisode ?? Infinity));
}

/** True if every episode in the release falls inside the filter. Releases without SxE never match. */
export function matchesEpisodeFilter(ranges: EpisodeRange[], release: ParsedRelease): boolean {
  if (release.season === undefined || release.episodes.length === 0) return false;
  return release.episodes.every((e) => ranges.some((r) => inRange(r, release.season!, e)));
}

export interface RuleContext {
  /** Episode keys this rule already downloaded, with whether that download was a repack. */
  downloadedEpisodes: Map<string, { repack: boolean }>;
  /** Last time this rule matched (ISO), for ignoreSubsequentDays. */
  lastMatchAt: string | null;
  now?: Date;
}

export type RuleDecision =
  | { match: true; episodeKeys: string[]; repack: boolean }
  | {
      match: false;
      reason: 'text' | 'episode' | 'duplicate' | 'ignore_days' | 'feed' | 'disabled';
    };

/** Full evaluation of one rule against one article title. */
export function evaluateRule(
  rule: DownloadRule,
  title: string,
  feedId: string,
  ctx: RuleContext,
): RuleDecision {
  if (!rule.enabled) return { match: false, reason: 'disabled' };
  if (rule.assignedFeedIds.length > 0 && !rule.assignedFeedIds.includes(feedId))
    return { match: false, reason: 'feed' };
  if (!matchesText(rule, title)) return { match: false, reason: 'text' };

  const release = parseRelease(title);
  if (
    rule.episodeFilter?.trim() &&
    !matchesEpisodeFilter(parseEpisodeFilter(rule.episodeFilter), release)
  ) {
    return { match: false, reason: 'episode' };
  }

  const now = ctx.now ?? new Date();
  if (rule.ignoreSubsequentDays && ctx.lastMatchAt) {
    const elapsedDays = (now.getTime() - new Date(ctx.lastMatchAt).getTime()) / 86_400_000;
    if (elapsedDays < rule.ignoreSubsequentDays) return { match: false, reason: 'ignore_days' };
  }

  const keys = episodeKeys(release);
  if (rule.smartEpisodeFilter && keys.length > 0) {
    // Duplicate unless it's a repack replacing a non-repack for every episode it covers.
    const dup = keys.every((k) => {
      const prev = ctx.downloadedEpisodes.get(k);
      return prev && (prev.repack || !release.repack);
    });
    if (dup) return { match: false, reason: 'duplicate' };
  }
  return { match: true, episodeKeys: keys, repack: release.repack };
}

/** Rules in evaluation order: priority ascending, then name. */
export function orderRules<T extends Pick<DownloadRule, 'priority' | 'name'>>(rules: T[]): T[] {
  return [...rules].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}
