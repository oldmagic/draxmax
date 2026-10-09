import { describe, expect, it } from 'vitest';
import { episodeKeys, parseRelease } from './parse-title.ts';

describe('parseRelease', () => {
  it.each([
    [
      'The.Expanse.S03E05.1080p.WEB-DL.x264-GRP',
      { title: 'The Expanse', season: 3, episodes: [5] },
    ],
    ['Severance S02E01E02 2160p ATVP WEB-DL', { title: 'Severance', season: 2, episodes: [1, 2] }],
    ['Show.Name.S01E01-E03.720p', { title: 'Show Name', season: 1, episodes: [1, 2, 3] }],
    ['Show Name 2x07 HDTV', { title: 'Show Name', season: 2, episodes: [7] }],
    [
      'Fargo.S05.COMPLETE.1080p.BluRay',
      { title: 'Fargo', season: 5, episodes: [], seasonPack: true },
    ],
    ['Doctor Who Season 3 Episode 4', { title: 'Doctor Who', season: 3, episodes: [4] }],
    [
      '[SubsPlease] Frieren - 12 (1080p) [ABCD1234].mkv',
      { title: 'Frieren', season: 1, episodes: [12], anime: true },
    ],
    [
      '[Erai-raws] Spy x Family Season 2 - 05 [1080p]',
      { title: 'Spy x Family', season: 2, episodes: [5] },
    ],
    [
      '[SubsPlease] Sousou no Frieren S2 - 05 (720p) [0A1B2C3D].mkv',
      { title: 'Sousou no Frieren', season: 2, episodes: [5], seasonPack: false },
    ],
    [
      '[SubsPlease] Gachiakuta (01-12) (1080p) [Batch]',
      { title: 'Gachiakuta', season: 1, episodes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    ],
    ['[Group] Show S2 - 01-03 [720p]', { title: 'Show', season: 2, episodes: [1, 2, 3] }],
    [
      'Dune.Part.Two.2024.2160p.UHD.BluRay.x265',
      { title: 'Dune Part Two', year: 2024, episodes: [] },
    ],
    ['Blade Runner 2049 (2017) 1080p', { title: 'Blade Runner 2049', year: 2017 }],
    ['The.Daily.Show.2024.05.01.720p.WEB', { title: 'The Daily Show', date: '2024-05-01' }],
    ['Show.S01E05.REPACK.1080p', { repack: true, resolution: '1080p' }],
  ])('%s', (name, expected) => {
    expect(parseRelease(name)).toMatchObject(expected);
  });

  it('builds episode keys for duplicate detection', () => {
    expect(episodeKeys(parseRelease('The.Expanse.S03E05.1080p'))).toEqual(['the expanse|s3e5']);
    expect(episodeKeys(parseRelease('The Expanse S03E05 720p'))).toEqual(['the expanse|s3e5']);
    expect(episodeKeys(parseRelease('Daily.Show.2024.05.01'))).toEqual(['daily show|2024-05-01']);
    expect(episodeKeys(parseRelease('Some.Movie.2020.1080p'))).toEqual([]);
  });
});
