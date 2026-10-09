import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { TorrentDTO } from '@draxmax/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/progress';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList } from '@/components/ui/tabs';
import { Tooltip } from '@/components/ui/tooltip';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { formatBytes, formatEta, formatPercent, formatSpeed } from '@/lib/format';
import { STATUS_META } from '@/lib/status';
import { useDownloadsUi } from '@/stores/downloads';
import { useTorrents } from '@/stores/torrents';

export function DetailSheet() {
  const id = useDownloadsUi((s) => s.detailId);
  const tab = useDownloadsUi((s) => s.detailTab);
  const torrent = useTorrents((s) => s.torrents.find((t) => t.id === id));
  const close = () => useDownloadsUi.getState().closeDetail();

  return (
    <Sheet
      open={!!torrent}
      onOpenChange={(o) => !o && close()}
      title={torrent?.name ?? ''}
      description={
        torrent ? (
          <Badge tone={STATUS_META[torrent.status].badge}>
            {STATUS_META[torrent.status].label}
          </Badge>
        ) : null
      }
    >
      {torrent && (
        <Tabs value={tab} onValueChange={(v) => useDownloadsUi.setState({ detailTab: v })}>
          <TabsList
            className="mb-5"
            items={[
              { value: 'general', label: 'General' },
              {
                value: 'files',
                label: `Files${torrent.files.length ? ` (${torrent.files.length})` : ''}`,
              },
              { value: 'trackers', label: `Trackers (${torrent.trackers.length})` },
              { value: 'peers', label: `Peers (${torrent.peers})` },
            ]}
          />
          <TabsContent value="general">
            <General t={torrent} />
          </TabsContent>
          <TabsContent value="files">
            <Files t={torrent} />
          </TabsContent>
          <TabsContent value="trackers">
            <Trackers t={torrent} />
          </TabsContent>
          <TabsContent value="peers">
            <Peers t={torrent} />
          </TabsContent>
        </Tabs>
      )}
    </Sheet>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 truncate text-sm font-medium tabular">{children}</div>
    </div>
  );
}

function General({ t }: { t: TorrentDTO }) {
  const meta = STATUS_META[t.status];
  const [tagInput, setTagInput] = useState('');
  const addTag = () => {
    const tags = tagInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (tags.length) void actions.update([t.id], { tags: [...new Set([...t.tags, ...tags])] });
    setTagInput('');
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="font-medium">{formatPercent(t.progress)}</span>
          <span className="text-muted tabular">
            {formatBytes(Math.round(t.progress * t.totalSize))} of {formatBytes(t.totalSize)}
          </span>
        </div>
        <ProgressBar value={t.progress} tone={meta.bar} label="Progress" />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Download">{formatSpeed(t.downloadSpeed)}</Stat>
        <Stat label="Upload">{formatSpeed(t.uploadSpeed)}</Stat>
        <Stat label="ETA">{t.status === 'downloading' ? formatEta(t.eta) : '—'}</Stat>
        <Stat label="Downloaded">{formatBytes(t.downloaded)}</Stat>
        <Stat label="Uploaded">{formatBytes(t.uploaded)}</Stat>
        <Stat label="Ratio">{t.ratio.toFixed(2)}</Stat>
        <Stat label="Peers">
          {t.peers} ({t.seeds} seeds)
        </Stat>
        <Stat label="Added">{new Date(t.addedAt).toLocaleString()}</Stat>
        <Stat label="Seeding time">{t.seedingTime > 0 ? formatEta(t.seedingTime) : '—'}</Stat>
        <Stat label="Completed">
          {t.completedAt ? new Date(t.completedAt).toLocaleString() : '—'}
        </Stat>
      </div>

      <dl className="space-y-2 text-sm">
        <div className="flex gap-3">
          <dt className="w-24 shrink-0 text-muted">Save path</dt>
          <dd className="flex min-w-0 items-start gap-1.5 font-mono text-xs">
            <span className="min-w-0 break-all">{t.savePath}</span>
            <button
              type="button"
              aria-label="Copy save path"
              className="text-muted hover:text-fg"
              onClick={() =>
                void navigator.clipboard
                  .writeText(t.savePath)
                  .then(() => toast.success('Save path copied'))
              }
            >
              <Copy className="size-3.5" />
            </button>
          </dd>
        </div>
        <div className="flex items-center gap-3">
          <dt className="w-24 shrink-0 text-muted">Info-hash</dt>
          <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <span className="truncate">{t.infoHash}</span>
            <button
              type="button"
              aria-label="Copy info-hash"
              className="text-muted hover:text-fg"
              onClick={() =>
                void navigator.clipboard
                  .writeText(t.infoHash)
                  .then(() => toast.success('Info-hash copied'))
              }
            >
              <Copy className="size-3.5" />
            </button>
          </dd>
        </div>
        {t.error && (
          <div className="flex gap-3">
            <dt className="w-24 shrink-0 text-muted">Error</dt>
            <dd className="text-danger">{t.error}</dd>
          </div>
        )}
      </dl>

      <section className="space-y-3 rounded-2xl border p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium">Sequential download</div>
            <div className="text-xs text-muted">
              Download pieces in order, useful for previewing media.
            </div>
          </div>
          <Switch
            label="Sequential download"
            checked={t.sequentialDownload}
            onChange={(v) => void actions.update([t.id], { sequential: v })}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">Category</div>
          <Button size="sm" onClick={() => useDownloadsUi.getState().askCategory([t.id])}>
            {t.category ?? 'None'}
          </Button>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">Tags</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {t.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-fg/8 py-0.5 pl-2.5 pr-1 text-xs"
              >
                #{tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  className="rounded-full p-0.5 text-muted hover:bg-surface-hover hover:text-fg"
                  onClick={() =>
                    void actions.update([t.id], { tags: t.tags.filter((x) => x !== tag) })
                  }
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                addTag();
              }}
            >
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add tag"
                aria-label="Add tag"
                className="h-7 w-28 text-xs"
              />
            </form>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium">
            Queue position <span className="text-muted tabular">#{t.priority + 1}</span>
          </div>
          <div className="flex gap-1">
            {(
              [
                ['top', ArrowUpToLine, 'Move to top'],
                ['up', ChevronUp, 'Move up'],
                ['down', ChevronDown, 'Move down'],
                ['bottom', ArrowDownToLine, 'Move to bottom'],
              ] as const
            ).map(([move, Icon, label]) => (
              <Tooltip key={move} content={label}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={label}
                  onClick={() => void actions.queue([t.id], move)}
                >
                  <Icon />
                </Button>
              </Tooltip>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function Files({ t }: { t: TorrentDTO }) {
  const files = t.files;
  if (files.length === 0)
    return (
      <p className="py-10 text-center text-sm text-muted">
        The file list appears once metadata is received.
      </p>
    );
  const allSelected = files.every((f) => f.selected);
  const setAll = () =>
    void actions.setFilePriorities(
      t.id,
      files.map((_, index) => ({ index, priority: allSelected ? 0 : 1 })),
    );
  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1 text-xs text-muted">
        <button type="button" className="font-medium text-accent hover:underline" onClick={setAll}>
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
        <span>
          {files.filter((f) => f.selected).length} of {files.length} selected ·{' '}
          {formatBytes(files.filter((f) => f.selected).reduce((s, f) => s + f.size, 0))}
        </span>
      </div>
      <ul className="space-y-1">
        {files.map((f, i) => (
          <li key={f.path}>
            <div className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-hover">
              <input
                type="checkbox"
                checked={f.selected}
                aria-label={`Download ${f.path}`}
                onChange={(e) =>
                  void actions.setFilePriorities(t.id, [
                    { index: i, priority: e.target.checked ? 1 : 0 },
                  ])
                }
                className="size-4 shrink-0 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm" title={f.path}>
                  {f.path}
                </span>
                <ProgressBar
                  value={f.progress}
                  tone={f.selected ? 'accent' : 'muted'}
                  className="mt-1.5 h-1"
                />
              </span>
              <select
                aria-label={`Priority of ${f.name}`}
                value={f.priority === 0 ? 0 : f.priority >= 6 ? 7 : f.priority >= 4 ? 4 : 1}
                onChange={(e) =>
                  void actions.setFilePriorities(t.id, [
                    { index: i, priority: Number(e.target.value) },
                  ])
                }
                className="h-7 rounded-lg border bg-surface-2 px-1.5 text-xs"
              >
                <option value={0}>Skip</option>
                <option value={1}>Normal</option>
                <option value={4}>High</option>
                <option value={7}>Maximum</option>
              </select>
              <span className="w-20 shrink-0 text-right text-xs text-muted tabular">
                {formatBytes(f.size)}
                <br />
                {formatPercent(f.progress)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TRACKER_TONE: Record<string, BadgeTone> = {
  working: 'success',
  updating: 'info',
  not_working: 'danger',
  disabled: 'muted',
};
const TRACKER_LABEL: Record<string, string> = {
  working: 'Working',
  updating: 'Updating',
  not_working: 'Not working',
  disabled: 'Disabled',
};

function Trackers({ t }: { t: TorrentDTO }) {
  const [adding, setAdding] = useState(false);
  const [urls, setUrls] = useState('');
  const submit = async () => {
    const list = urls
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length && (await actions.addTrackers(t.id, list))) {
      setUrls('');
      setAdding(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void actions.reannounce([t.id])}>
          Reannounce
        </Button>
        <Button size="sm" onClick={() => setAdding((a) => !a)}>
          <Plus /> Add trackers
        </Button>
      </div>
      {adding && (
        <div className="space-y-2 rounded-2xl border p-3">
          <Textarea
            value={urls}
            onChange={(e) => setUrls(e.target.value)}
            placeholder="udp://tracker.example.org:1337/announce (one per line)"
            className="font-mono text-xs"
            aria-label="Tracker URLs"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void submit()}>
              Add
            </Button>
          </div>
        </div>
      )}
      {t.trackers.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          No trackers. Peers are found via DHT, PEX and local discovery.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {t.trackers.map((tr) => (
            <li key={tr.url} className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs" title={tr.url}>
                  {tr.url}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted tabular">
                  <Badge tone={TRACKER_TONE[tr.status] ?? 'muted'}>
                    {TRACKER_LABEL[tr.status] ?? tr.status}
                  </Badge>
                  {tr.seeders !== undefined && <span>{tr.seeders} seeds</span>}
                  {tr.leechers !== undefined && <span>{tr.leechers} leechers</span>}
                  {tr.lastAnnounce && (
                    <span>announced {new Date(tr.lastAnnounce).toLocaleTimeString()}</span>
                  )}
                  {tr.message && tr.status === 'not_working' && (
                    <span className="truncate text-danger" title={tr.message}>
                      {tr.message}
                    </span>
                  )}
                </div>
              </div>
              <Switch
                label={`Enable ${tr.url}`}
                checked={tr.status !== 'disabled'}
                onChange={(v) => void actions.setTrackerEnabled(t.id, tr.url, v)}
              />
              <Tooltip content="Remove tracker">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${tr.url}`}
                  onClick={() => void actions.removeTracker(t.id, tr.url)}
                >
                  <Trash2 />
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Peers({ t }: { t: TorrentDTO }) {
  const running = !['paused', 'error', 'queued'].includes(t.status);
  const { data: peers = [], isLoading } = useQuery({
    queryKey: ['peers', t.id],
    queryFn: () => api.peers(t.id),
    refetchInterval: 2000,
    enabled: running,
  });
  if (!running)
    return <p className="py-10 text-center text-sm text-muted">The torrent isn't running.</p>;
  if (isLoading) return <p className="py-10 text-center text-sm text-muted">Loading…</p>;
  if (peers.length === 0)
    return <p className="py-10 text-center text-sm text-muted">No connected peers yet.</p>;
  const sorted = [...peers].sort(
    (a, b) => b.downloadSpeed + b.uploadSpeed - (a.downloadSpeed + a.uploadSpeed),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular">
        <thead className="text-left text-muted">
          <tr>
            <th className="pb-2 font-medium">Address</th>
            <th className="pb-2 font-medium">Client</th>
            <th className="pb-2 text-right font-medium">Progress</th>
            <th className="pb-2 text-right font-medium">Down</th>
            <th className="pb-2 text-right font-medium">Up</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <tr key={p.address} className="border-t">
              <td className="py-2 pr-3 font-mono">
                {p.address}
                {p.type.startsWith('utp') && <span className="ml-1.5 text-muted">µTP</span>}
              </td>
              <td className="max-w-40 truncate py-2 pr-3">{p.client}</td>
              <td className="py-2 text-right">{p.seeder ? 'Seed' : formatPercent(p.progress)}</td>
              <td className="py-2 text-right">{formatSpeed(p.downloadSpeed)}</td>
              <td className="py-2 text-right">{formatSpeed(p.uploadSpeed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
