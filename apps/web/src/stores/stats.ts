import { create } from 'zustand';
import type { StatsSample, StatsSnapshot } from '@draxmax/shared';

const LIVE_POINTS = 300;

interface StatsState {
  latest: StatsSnapshot | null;
  /** Rolling per-second samples received over WebSocket (seeded from /api/stats/history). */
  live: StatsSample[];
  push(s: StatsSnapshot): void;
  seed(samples: StatsSample[]): void;
}

export const useStats = create<StatsState>((set) => ({
  latest: null,
  live: [],
  push: (s) =>
    set((st) => {
      const sample = { t: Date.parse(s.time), down: s.downloadSpeed, up: s.uploadSpeed };
      const live =
        st.live.length && st.live[st.live.length - 1]!.t >= sample.t
          ? st.live
          : [...st.live, sample].slice(-LIVE_POINTS);
      return { latest: s, live };
    }),
  seed: (samples) =>
    set((st) => (st.live.length >= samples.length ? st : { live: samples.slice(-LIVE_POINTS) })),
}));
