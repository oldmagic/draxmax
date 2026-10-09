import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { fetchBytes, isPrivateAddress } from './net/http.ts';
import { parseRelease } from './media/parse-title.ts';
import { isUnsafeTorrentPath, parseTorrentFile } from './torrent/sources.ts';
import { makeTorrentFile } from './testing/index.ts';

describe('SSRF protection', () => {
  it('classifies private and public addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.20.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '104.16.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses private targets for untrusted links, and never redirects public → private', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1/secret' });
        return res.end();
      }
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(fetchBytes(`${url}/x`, { allowPrivate: false })).rejects.toThrow(
        /not a public address/,
      );
      // Admin-configured LAN services still work.
      expect(Buffer.from((await fetchBytes(`${url}/x`)).body).toString()).toBe('ok');
      await expect(fetchBytes('file:///etc/passwd')).rejects.toThrow(/Unsupported URL scheme/);
    } finally {
      server.close();
    }
  });
});

describe('torrent path traversal', () => {
  it('flags paths that escape the save folder', () => {
    for (const p of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'C:\\Windows\\x',
      'ok/..\\..\\evil.exe',
      '\\\\server\\share',
    ])
      expect(isUnsafeTorrentPath(p, true), p).toBe(true);
    expect(isUnsafeTorrentPath('Show/Show: Part 1.mkv', false)).toBe(false);
    expect(isUnsafeTorrentPath('Show/file:stream', true)).toBe(true);
    expect(isUnsafeTorrentPath('Show/S01/e01.mkv', true)).toBe(false);
  });

  it('refuses .torrent files with backslash traversal', async () => {
    await expect(
      parseTorrentFile(makeTorrentFile('ok', [{ path: ['..\\..\\..\\evil.exe'], length: 1 }])),
    ).rejects.toThrow(/outside its folder/);
  });
});

it('parses hostile release names quickly', () => {
  const t = Date.now();
  parseRelease(`[${'a'.repeat(100_000)}] - ${'1 '.repeat(50_000)}`);
  parseRelease('S01E'.repeat(50_000));
  expect(Date.now() - t).toBeLessThan(500);
});
