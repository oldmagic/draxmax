/** Live statistics pushed every second and returned by GET /api/stats. */
export interface StatsSnapshot {
  time: string;
  downloadSpeed: number;
  uploadSpeed: number;
  session: { downloaded: number; uploaded: number; ratio: number; startedAt: string };
  allTime: { downloaded: number; uploaded: number; ratio: number };
  torrents: {
    total: number;
    downloading: number;
    seeding: number;
    paused: number;
    queued: number;
    checking: number;
    error: number;
  };
  peers: number;
  seeds: number;
  dhtNodes: number;
  trackers: { working: number; updating: number; notWorking: number; disabled: number };
  disk: { path: string; free: number; total: number; usedByTorrents: number } | null;
  top: { id: string; name: string; downloadSpeed: number; uploadSpeed: number }[];
}

/** One aggregated sample for charts. */
export interface StatsSample {
  /** Epoch ms. */
  t: number;
  down: number;
  up: number;
}

export interface StatsHistory {
  range: 'live' | 'day';
  /** Seconds between samples. */
  step: number;
  samples: StatsSample[];
}
