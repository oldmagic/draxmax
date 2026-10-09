const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 → "1.5 KB" (base 1024). */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '—';
}

/** Seconds → "2h 05m", "4m 10s", "∞" for null. */
export function formatEta(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '∞';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatPercent(progress: number): string {
  const p = progress * 100;
  return p >= 100 ? '100%' : `${p.toFixed(p < 10 ? 1 : 0)}%`;
}

/** "/mnt/nas/media/Anime/Show/S01" → "…/Anime/Show/S01": the end of a path is the informative part. */
export function shortPath(path: string, keep = 3): string {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > keep ? `…${sep}${parts.slice(-keep).join(sep)}` : path;
}

export function formatRatio(r: number): string {
  return r.toFixed(2);
}
