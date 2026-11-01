import { z } from 'zod';

/** XDCC indexers that come with DraxMax. They search IRC bots' pack lists. */
export const BUILTIN_XDCC_INDEXERS = [
  { id: 'xdccinfo', name: 'xdcc.info', url: 'https://xdcc.info' },
] as const;
export type XdccIndexerId = (typeof BUILTIN_XDCC_INDEXERS)[number]['id'];
export const XDCC_INDEXER_IDS = BUILTIN_XDCC_INDEXERS.map((b) => b.id) as [
  XdccIndexerId,
  ...XdccIndexerId[],
];

/** Where an XDCC pack is offered. Shown with search results. */
export interface XdccPackInfo {
  network: string;
  bot: string;
  channel: string | null;
  pack: number;
  /** Times the pack was downloaded, as counted by the bot. */
  gets: number | null;
  /** When the bot last advertised it (ISO). */
  lastSeen: string | null;
}

export const XDCC_STATUSES = [
  /** Waiting for a free slot in DraxMax (see `xdccMaxActive`). */
  'queued',
  /** Connecting to the IRC network and joining the bot's channel. */
  'connecting',
  /** Asked the bot; waiting for it to send (it may have queued us). */
  'requesting',
  'downloading',
  'completed',
  'error',
  'cancelled',
] as const;
export type XdccStatus = (typeof XDCC_STATUSES)[number];

export interface XdccTransferDTO {
  id: string;
  filename: string;
  network: string;
  /** IRC server, e.g. irc.rizon.net:6697. */
  server: string;
  bot: string;
  channel: string | null;
  pack: number;
  /** Bytes; null until the bot says. */
  size: number | null;
  received: number;
  /** Bytes/s. */
  speed: number;
  status: XdccStatus;
  /** What the bot or network last said (queue position, errors, …). */
  message: string | null;
  error: string | null;
  savePath: string;
  /** Full path of the finished file. */
  filePath: string | null;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
}

export const xdccAddSchema = z.object({
  /** A search result handle (from GET /api/search). */
  id: z.string().min(1).max(100),
  savePath: z.string().trim().max(4096).optional(),
});
