/**
 * Release-name parsing shared by the RSS smart episode filter and the library scanner.
 * Heuristic by nature: tuned for common scene/P2P and anime naming conventions.
 */

export interface ParsedRelease {
  /** Human title with punctuation normalised, e.g. "The Expanse". */
  title: string;
  /** Lower-case alphanumeric key for matching, e.g. "the expanse". */
  key: string;
  year?: number;
  season?: number;
  /** Episodes in this release (several for multi-episode packs). */
  episodes: number[];
  /** Air date for daily shows (YYYY-MM-DD). */
  date?: string;
  /** Whole-season pack (season known, no episode). */
  seasonPack: boolean;
  /** Probable anime (fansub group tag, absolute numbering). */
  anime: boolean;
  repack: boolean;
  resolution?: string;
}

const QUALITY_TOKENS =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10?\+?|dv|dolby ?vision|web[- ]?dl|webrip|web|bluray|blu-ray|bdrip|brrip|dvdrip|hdtv|hdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|aac\d?(\.\d)?|ddp?\d?(\.\d)?|eac3|ac3|dts(-hd)?|truehd|atmos|10bit|8bit|proper|repack|internal|limited|extended|unrated|directors? cut|imax|multi|dual audio|subbed|dubbed|nf|amzn|dsnp|hmax|atvp|hulu)\b/i;

/** Lower-case key: letters/digits only, single-spaced, leading article kept. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[._]+/g, ' ')
    .replace(/\s*[-–]\s*$/, '')
    .replace(/[([{]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function range(from: number, to: number): number[] {
  if (to < from || to - from > 500) return [from];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Parses a torrent/release name. */
export function parseRelease(name: string): ParsedRelease {
  // Titles come from feeds and peers; real release names are far shorter than this, and the
  // cap bounds regex work on hostile input.
  let s = name.slice(0, 512).trim();
  // Strip file extension.
  s = s.replace(/\.(mkv|mp4|avi|m4v|ts|wmv|mov|torrent)$/i, '');

  const groupTag = /^\s*\[([^\]]+)\]\s*/.exec(s);
  let anime = false;
  if (groupTag) {
    anime = true;
    s = s.slice(groupTag[0].length);
  }

  const repack = /\b(repack|proper|rerip)\b/i.test(s);
  const resolution = /\b(2160p|1080p|720p|576p|480p)\b/i.exec(s)?.[1]?.toLowerCase();
  const out: ParsedRelease = { title: '', key: '', episodes: [], seasonPack: false, anime, repack };
  if (resolution) out.resolution = resolution;

  let cut = -1;
  const take = (m: RegExpExecArray | null) => {
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
    return m;
  };

  // S01E02, S01E02E03, S01E02-E05, S01E02-05, S01.E02
  const sxe = take(/\bS(\d{1,3})[ .]?E(\d{1,4})(?:(?:[-–]?E|[-–])(\d{1,4}))*/i.exec(s));
  if (sxe) {
    out.season = Number(sxe[1]);
    const nums = [...sxe[0].matchAll(/E?(\d{1,4})/gi)].slice(1).map((m) => Number(m[1]));
    const first = Number(sxe[2]);
    const last = nums.length > 1 ? nums[nums.length - 1]! : first;
    out.episodes = /[-–]/.test(sxe[0]) ? range(first, last) : [...new Set(nums)];
  }

  // 1x02
  if (out.season === undefined) {
    const x = take(/\b(\d{1,2})x(\d{1,3})(?:[-–](\d{1,3}))?\b/i.exec(s));
    if (x) {
      out.season = Number(x[1]);
      out.episodes = x[3] ? range(Number(x[2]), Number(x[3])) : [Number(x[2])];
    }
  }

  // "Season 2 Episode 5" / "Season 2" / "S02" pack
  if (out.season === undefined) {
    const long = take(/\bSeason[ ._]?(\d{1,3})(?:[ ._]*(?:Episode|Ep)[ ._]?(\d{1,4}))?/i.exec(s));
    const season = long ?? take(/\bS(\d{1,2})(?![\dE])(?:[-–]S?(\d{1,2}))?\b/i.exec(s));
    if (season) {
      out.season = Number(season[1]);
      if (long?.[2]) out.episodes = [Number(long[2])];
      // Anime per-season numbering: "Show S2 - 05", "Show Season 2 - 05", "Show S2 - 01-12".
      const ep = /^\s[-–]\s(\d{1,4})(?:v\d)?(?:\s?[-~–]\s?(\d{1,4})(?:v\d)?)?(?=\s|$|\[|\()/.exec(
        s.slice(season.index + season[0].length),
      );
      if (ep && !long?.[2] && Number(ep[1]) < 1900)
        out.episodes = ep[2] ? range(Number(ep[1]), Number(ep[2])) : [Number(ep[1])];
    }
  }

  // Daily shows: 2024.05.01 / 2024-05-01
  const date = /\b((?:19|20)\d{2})[.\- ](0[1-9]|1[0-2])[.\- ](0[1-9]|[12]\d|3[01])\b/.exec(s);
  if (date && out.season === undefined) {
    take(date);
    out.date = `${date[1]}-${date[2]}-${date[3]}`;
  }

  // Anime absolute numbering: "Title - 05", "Title - 05v2", "Title 05 [1080p]"
  if (out.season === undefined && !out.date) {
    // Batches: "Title - 01-12", "Title (01-12)", "Title - 01 ~ 12".
    const batch = /\s(?:[-–]\s|\()(\d{1,4})\s?[-~–]\s?(\d{1,4})(?:\)|\s|$|\[)/.exec(s);
    const abs =
      /\s[-–]\s(\d{1,4})(?:v\d)?(?:\s|$|\[|\()/.exec(s) ??
      (anime ? /\s(\d{1,4})(?:v\d)?\s*[[(]/.exec(s) : null);
    if (batch && Number(batch[2]) < 1900 && Number(batch[1]) < Number(batch[2])) {
      take(batch);
      out.anime = true;
      out.season = 1;
      out.episodes = range(Number(batch[1]), Number(batch[2]));
    } else if (abs && Number(abs[1]) < 1900) {
      take(abs);
      out.anime = true;
      out.season = 1;
      out.episodes = [Number(abs[1])];
    }
  }

  // Year (not a daily-show date): "Movie (2019)", "Movie.2019.1080p"
  const yearRe = /[([ .]((?:19|20)\d{2})[)\] .]/g;
  for (const m of s.matchAll(yearRe)) {
    if (out.date && s.indexOf(out.date.slice(0, 4)) === m.index + 1) continue;
    const y = Number(m[1]);
    if (y >= 1900 && y <= new Date().getFullYear() + 2 && m.index > 0) {
      out.year = y;
      if (out.season === undefined && !out.date) take(m as RegExpExecArray);
      break;
    }
  }

  const q = QUALITY_TOKENS.exec(s);
  if (q) take(q);
  if (cut === -1) {
    const br = /[[(]/.exec(s);
    if (br && br.index > 0) cut = br.index;
  }

  const rawTitle = cut > 0 ? s.slice(0, cut) : s;
  out.title = cleanTitle(rawTitle.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')) || cleanTitle(s);
  out.key = titleKey(out.title);
  out.seasonPack = out.season !== undefined && out.episodes.length === 0;
  return out;
}

/** Keys identifying each episode of a release, for duplicate detection ("show|s01e02" / "show|2024-05-01"). */
export function episodeKeys(r: ParsedRelease): string[] {
  if (r.date) return [`${r.key}|${r.date}`];
  if (r.season === undefined) return [];
  if (r.episodes.length === 0) return [`${r.key}|s${r.season}`];
  return r.episodes.map((e) => `${r.key}|s${r.season}e${e}`);
}
