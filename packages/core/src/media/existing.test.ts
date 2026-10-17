import { describe, expect, it } from 'vitest';
import type { TorrentItem } from '@draxmax/shared';
import { contentKeys, findExisting } from './existing.ts';

const torrent = (name: string, files: string[] = []) =>
  ({ name, files: files.map((f) => ({ name: f, path: f })) }) as unknown as TorrentItem;

describe('existing content', () => {
  it('keys episodes, season packs and movies', () => {
    expect(contentKeys('[SubsPlease] Frieren - 05 (1080p)')).toEqual(['frieren|s1e5']);
    expect(contentKeys('Show S02 1080p')).toEqual(['show|s2']);
    expect(contentKeys('Dune Part Two 2024 2160p')).toEqual(['dune part two|2024']);
    expect(contentKeys('Some Random Thing')).toEqual([]);
  });

  it('finds an episode in a season pack, a movie in the client, and nothing for new episodes', async () => {
    const list = [
      torrent('Show S02 1080p', ['Show S02 1080p/Show.S02E01.mkv']),
      torrent('Dune.Part.Two.2024.1080p.WEB'),
    ];
    expect(await findExisting('Show S02E04 720p', list, null)).toBe('Show S02 1080p');
    expect(await findExisting('Dune Part Two (2024) 2160p', list, null)).toBe(
      'Dune.Part.Two.2024.1080p.WEB',
    );
    expect(await findExisting('Show S03E01 720p', list, null)).toBeNull();
    expect(await findExisting('Some Random Thing', list, null)).toBeNull();
  });
});
