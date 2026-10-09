/** True for announce URLs WebTorrent can use: http(s), udp and ws(s). */
export function isTrackerUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return ['http:', 'https:', 'udp:', 'ws:', 'wss:'].includes(u.protocol) && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Canonical form used for de-duplication (trailing slash dropped, as bittorrent-tracker does). */
export function normalizeTrackerUrl(url: string): string {
  const t = url.trim();
  return t.endsWith('/') ? t.slice(0, -1) : t;
}

/** Merges tracker lists preserving first-seen order, de-duplicated by normalised URL. */
export function mergeTrackers(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const url of list) {
      const key = normalizeTrackerUrl(url);
      if (!isTrackerUrl(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(url.trim());
    }
  }
  return out;
}

/** Removes `tr` parameters from a magnet URI so the engine announces only to the managed list. */
export function stripMagnetTrackers(magnet: string): string {
  const q = magnet.indexOf('?');
  if (q === -1) return magnet;
  const params = magnet
    .slice(q + 1)
    .split('&')
    .filter((p) => p !== '' && !/^tr(\.\d+)?=/i.test(p));
  return `${magnet.slice(0, q)}?${params.join('&')}`;
}
