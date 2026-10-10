import { decode as decodeMagnet } from 'magnet-uri';
import parseTorrent from 'parse-torrent';
import { CoreError } from '../errors.ts';

export interface ParsedSource {
  infoHash: string;
  name: string | null;
  totalSize: number;
  announce: string[];
  /** BEP 27 private flag (unknown for magnets until metadata arrives). */
  private: boolean;
}

const INFO_HASH_RE = /^[0-9a-f]{40}$/;

/** Validates a magnet URI and extracts its v1 info-hash. */
export function parseMagnet(uri: string): ParsedSource {
  let data;
  try {
    data = decodeMagnet(uri);
  } catch {
    throw new CoreError('invalid_input', 'Malformed magnet link');
  }
  const infoHash = data.infoHash?.toLowerCase();
  if (!infoHash || !INFO_HASH_RE.test(infoHash)) {
    throw new CoreError(
      'invalid_input',
      'Magnet link has no BitTorrent v1 info-hash (urn:btih). v2-only magnets are not supported.',
    );
  }
  const dn = data.name ?? data.dn;
  return {
    infoHash,
    name: (Array.isArray(dn) ? dn[0] : dn) ?? null,
    totalSize: 0,
    announce: data.announce ?? [],
    private: false,
  };
}

/**
 * A torrent file path that could escape the save folder: `..` segments, absolute or drive
 * paths, or Windows separators/streams. parse-torrent resolves `..` between `/`-separated
 * parts, but leaves backslashes alone, so `..\\..\\evil.exe` would reach outside the save
 * folder on Windows (the classic .torrent path traversal, e.g. CVE-2010-0012).
 */
export function isUnsafeTorrentPath(p: string, windows = process.platform === 'win32'): boolean {
  if (!p || p.includes('\0') || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return true;
  // ':' is an ordinary character on Linux/macOS but a drive or stream separator on Windows.
  return p.split(/[\\/]/).some((seg) => seg === '..' || (windows && seg.includes(':')));
}

/** Validates `.torrent` bytes and extracts metadata. */
export async function parseTorrentFile(
  data: Uint8Array,
): Promise<ParsedSource & { files: { name: string; path: string; size: number }[] }> {
  let parsed;
  try {
    parsed = await parseTorrent(data);
  } catch {
    throw new CoreError('invalid_input', 'Not a valid .torrent file');
  }
  if (!parsed.info || !parsed.infoHash || !INFO_HASH_RE.test(parsed.infoHash)) {
    throw new CoreError('invalid_input', 'Not a valid .torrent file (missing info dictionary)');
  }
  if ((parsed.files ?? []).some((f) => isUnsafeTorrentPath(f.path)))
    throw new CoreError('invalid_input', 'This torrent has file paths outside its folder; refused');
  return {
    infoHash: parsed.infoHash,
    name: parsed.name ?? null,
    totalSize: parsed.length ?? 0,
    announce: parsed.announce ?? [],
    private: (parsed as { private?: boolean }).private === true,
    files: (parsed.files ?? []).map((f) => ({ name: f.name, path: f.path, size: f.length })),
  };
}
