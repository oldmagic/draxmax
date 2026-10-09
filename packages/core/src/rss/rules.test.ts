import { describe, expect, it } from 'vitest';
import type { DownloadRule } from '@draxmax/shared';
import {
  evaluateRule,
  matchesText,
  parseEpisodeFilter,
  validateRule,
  type RuleContext,
} from './rules.ts';

const rule = (p: Partial<DownloadRule> = {}): DownloadRule => ({
  id: 'r1',
  name: 'Rule',
  enabled: true,
  priority: 0,
  mustContain: [],
  mustNotContain: [],
  useRegex: false,
  smartEpisodeFilter: false,
  assignedFeedIds: [],
  tags: [],
  addPaused: false,
  ...p,
});
const ctx = (p: Partial<RuleContext> = {}): RuleContext => ({
  downloadedEpisodes: new Map(),
  lastMatchAt: null,
  ...p,
});

describe('matchesText', () => {
  it('wildcard mode: words AND, entries OR, | alternatives, * and ?', () => {
    const r = {
      mustContain: ['expanse 1080p', 'severance'],
      mustNotContain: ['x265'],
      useRegex: false,
    };
    expect(matchesText(r, 'The.Expanse.S03E05.1080p.WEB')).toBe(true);
    expect(matchesText(r, 'The.Expanse.S03E05.720p.WEB')).toBe(false);
    expect(matchesText(r, 'Severance S02E01 2160p')).toBe(true);
    expect(matchesText(r, 'The.Expanse.S03E05.1080p.x265')).toBe(false);
    expect(
      matchesText(
        { ...r, mustContain: ['frieren 1080p|720p'] },
        '[SubsPlease] Frieren - 12 (720p)',
      ),
    ).toBe(true);
    expect(matchesText({ ...r, mustContain: ['s0?e*'] }, 'Show S03E01')).toBe(true);
    expect(matchesText({ ...r, mustContain: [] }, 'Anything')).toBe(true);
  });

  it('regex mode, case-insensitive', () => {
    expect(
      matchesText(
        { mustContain: ['^the\\.expanse\\.s\\d+'], mustNotContain: [], useRegex: true },
        'The.Expanse.S03E05',
      ),
    ).toBe(true);
    expect(() =>
      validateRule({ mustContain: ['(unclosed'], mustNotContain: [], useRegex: true }),
    ).toThrow(/Invalid regular/);
  });
});

describe('episode filter', () => {
  it('parses all forms and rejects bad input', () => {
    expect(parseEpisodeFilter('1x2;3x5-10;4x1-5x3;6x8-')).toEqual([
      { fromSeason: 1, fromEpisode: 2, toSeason: 1, toEpisode: 2 },
      { fromSeason: 3, fromEpisode: 5, toSeason: 3, toEpisode: 10 },
      { fromSeason: 4, fromEpisode: 1, toSeason: 5, toEpisode: 3 },
      { fromSeason: 6, fromEpisode: 8, toSeason: null, toEpisode: null },
    ]);
    expect(parseEpisodeFilter('1x01-1x10')[0]).toEqual({
      fromSeason: 1,
      fromEpisode: 1,
      toSeason: 1,
      toEpisode: 10,
    });
    expect(() => parseEpisodeFilter('banana')).toThrow(/Invalid episode filter/);
    expect(() => parseEpisodeFilter('2x5-1x3')).toThrow(/ends before/);
  });

  it('filters releases', () => {
    const r = rule({ mustContain: ['show'], episodeFilter: '2x5-; 1x3' });
    expect(evaluateRule(r, 'Show S01E03 720p', 'f', ctx()).match).toBe(true);
    expect(evaluateRule(r, 'Show S01E04 720p', 'f', ctx()).match).toBe(false);
    expect(evaluateRule(r, 'Show S02E05', 'f', ctx()).match).toBe(true);
    expect(evaluateRule(r, 'Show S07E01', 'f', ctx()).match).toBe(true);
    expect(evaluateRule(r, 'Show Complete Pack', 'f', ctx()).match).toBe(false);
  });
});

describe('evaluateRule', () => {
  it('smart episode filter skips duplicates but allows one repack', () => {
    const r = rule({ mustContain: ['expanse'], smartEpisodeFilter: true });
    const first = evaluateRule(r, 'The.Expanse.S03E05.1080p', 'f', ctx());
    expect(first).toEqual({ match: true, episodeKeys: ['the expanse|s3e5'], repack: false });
    const downloaded = new Map([['the expanse|s3e5', { repack: false }]]);
    expect(
      evaluateRule(r, 'The Expanse S03E05 720p', 'f', ctx({ downloadedEpisodes: downloaded })),
    ).toEqual({ match: false, reason: 'duplicate' });
    expect(
      evaluateRule(
        r,
        'The.Expanse.S03E05.REPACK.1080p',
        'f',
        ctx({ downloadedEpisodes: downloaded }),
      ).match,
    ).toBe(true);
    const repacked = new Map([['the expanse|s3e5', { repack: true }]]);
    expect(
      evaluateRule(r, 'The.Expanse.S03E05.PROPER.1080p', 'f', ctx({ downloadedEpisodes: repacked }))
        .match,
    ).toBe(false);
  });

  it('honours feed assignment, ignore-days and disabled rules', () => {
    expect(evaluateRule(rule({ assignedFeedIds: ['a'] }), 'x', 'b', ctx())).toEqual({
      match: false,
      reason: 'feed',
    });
    expect(evaluateRule(rule({ enabled: false }), 'x', 'a', ctx())).toEqual({
      match: false,
      reason: 'disabled',
    });
    const now = new Date('2026-01-10T00:00:00Z');
    const r = rule({ ignoreSubsequentDays: 3 });
    expect(evaluateRule(r, 'x', 'a', ctx({ lastMatchAt: '2026-01-08T00:00:00Z', now }))).toEqual({
      match: false,
      reason: 'ignore_days',
    });
    expect(evaluateRule(r, 'x', 'a', ctx({ lastMatchAt: '2026-01-06T00:00:00Z', now })).match).toBe(
      true,
    );
  });
});
