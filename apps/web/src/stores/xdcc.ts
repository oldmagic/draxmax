import { create } from 'zustand';
import type { XdccTransferDTO } from '@draxmax/shared';

interface XdccState {
  transfers: XdccTransferDTO[];
  /** The list has come from the server at least once. */
  loaded: boolean;
  upsert(t: XdccTransferDTO): void;
  drop(id: string): void;
}

/** XDCC transfers, kept current by the live feed (`xdcc:transfers`). */
export const useXdcc = create<XdccState>((set) => ({
  transfers: [],
  loaded: false,
  upsert: (t) =>
    set((s) => {
      const i = s.transfers.findIndex((x) => x.id === t.id);
      if (i === -1) return { transfers: [t, ...s.transfers] };
      const next = s.transfers.slice();
      next[i] = t;
      return { transfers: next };
    }),
  drop: (id) => set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),
}));
