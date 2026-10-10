type BValue = number | string | Uint8Array | BValue[] | { [key: string]: BValue };

/** Tiny bencoder for building `.torrent` fixtures in tests. */
export function bencode(value: BValue): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  const push = (s: string) => parts.push(enc.encode(s));
  const walk = (v: BValue): void => {
    if (typeof v === 'number') push(`i${Math.trunc(v)}e`);
    else if (typeof v === 'string') {
      const b = enc.encode(v);
      push(`${b.length}:`);
      parts.push(b);
    } else if (v instanceof Uint8Array) {
      push(`${v.length}:`);
      parts.push(v);
    } else if (Array.isArray(v)) {
      push('l');
      v.forEach(walk);
      push('e');
    } else {
      push('d');
      for (const k of Object.keys(v).sort()) {
        walk(k);
        walk(v[k]!);
      }
      push('e');
    }
  };
  walk(value);
  return Buffer.concat(parts);
}

/** Builds a minimal valid multi-file `.torrent`. */
export function makeTorrentFile(
  name: string,
  files: { path: string[]; length: number }[],
  announce = 'udp://tracker.example:1337',
  /** Extra keys for the info dictionary, e.g. `{ private: 1 }`. */
  info: { [key: string]: BValue } = {},
): Uint8Array {
  const pieceLength = 16384;
  const total = files.reduce((s, f) => s + f.length, 0);
  const pieces = new Uint8Array(20 * Math.max(1, Math.ceil(total / pieceLength)));
  return bencode({
    announce,
    info: { name, 'piece length': pieceLength, pieces, files, ...info },
  });
}
