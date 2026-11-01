import { useQuery } from '@tanstack/react-query';
import { Loader2, MessagesSquare, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { Link } from 'wouter';
import type { XdccStatus, XdccTransferDTO } from '@draxmax/shared';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProgressBar, type ProgressTone } from '@/components/ui/progress';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { formatBytes, formatEta, formatSpeed } from '@/lib/format';
import { useXdcc } from '@/stores/xdcc';

const STATUS: Record<XdccStatus, { label: string; tone: BadgeTone; bar: ProgressTone }> = {
  queued: { label: 'Waiting', tone: 'muted', bar: 'muted' },
  connecting: { label: 'Connecting', tone: 'info', bar: 'muted' },
  requesting: { label: 'Asking the bot', tone: 'info', bar: 'muted' },
  downloading: { label: 'Downloading', tone: 'accent', bar: 'accent' },
  completed: { label: 'Done', tone: 'success', bar: 'success' },
  error: { label: 'Failed', tone: 'danger', bar: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted', bar: 'muted' },
};

/** XDCC transfers: files fetched from IRC bots, with their progress and what the bot said. */
export function XdccPage() {
  const transfers = useXdcc((s) => s.transfers);
  const loaded = useXdcc((s) => s.loaded);
  // The live feed only sends the list once there is one; ask for it the first time.
  const initial = useQuery({ queryKey: ['xdcc'], queryFn: api.xdccTransfers, enabled: !loaded });
  useEffect(() => {
    if (initial.data && !useXdcc.getState().loaded)
      useXdcc.setState({ transfers: initial.data, loaded: true });
  }, [initial.data]);

  const finished = transfers.filter((t) => ['completed', 'cancelled', 'error'].includes(t.status));
  const clearFinished = () =>
    void Promise.all(
      finished
        .filter((t) => t.status === 'completed')
        .map((t) => api.removeXdcc(t.id).then(() => useXdcc.getState().drop(t.id))),
    ).catch((e: Error) => toast.error(e.message));

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end gap-3 pb-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">XDCC</h1>
          <p className="mt-1 text-sm text-muted">
            Files from IRC bots. Find packs on the{' '}
            <Link href="/search" className="text-accent hover:underline">
              Search
            </Link>{' '}
            page; XDCC results are marked with the bot and network.
          </p>
        </div>
        {finished.some((t) => t.status === 'completed') && (
          <Button size="sm" variant="ghost" onClick={clearFinished}>
            Clear finished
          </Button>
        )}
      </header>
      <section className="glass min-h-0 flex-1 overflow-y-auto rounded-2xl">
        {transfers.length === 0 ? (
          <div className="grid h-full place-items-center p-10 text-center text-sm text-muted">
            {!loaded && initial.isFetching ? (
              <Loader2 className="size-5 animate-spin" aria-label="Loading" />
            ) : (
              <div className="space-y-3">
                <MessagesSquare className="mx-auto size-8 opacity-60" />
                <p>No XDCC transfers yet.</p>
                <Link
                  href="/search"
                  className="inline-flex items-center gap-1.5 text-accent hover:underline"
                >
                  <Search className="size-4" /> Search for something
                </Link>
              </div>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border/60" aria-label="XDCC transfers">
            {transfers.map((t) => (
              <Transfer key={t.id} t={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Transfer({ t }: { t: XdccTransferDTO }) {
  const st = STATUS[t.status];
  const progress = t.size ? t.received / t.size : 0;
  const active = ['queued', 'connecting', 'requesting', 'downloading'].includes(t.status);
  const fail = (e: Error) => toast.error(e.message);
  const remove = () => {
    let deleteFile = false;
    if (t.status === 'completed') {
      if (!confirm(`Remove ${t.filename} from the list?`)) return;
      deleteFile = confirm('Also delete the downloaded file? Cancel keeps it.');
    } else if (!confirm(`Remove ${t.filename}? The partly downloaded file is deleted.`)) return;
    void api
      .removeXdcc(t.id, deleteFile)
      .then(() => useXdcc.getState().drop(t.id))
      .catch(fail);
  };

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={t.filePath ?? t.filename}>
            {t.filename}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted tabular">
            <Badge tone={st.tone}>{st.label}</Badge>
            <span title={t.server}>
              {t.bot} · {t.network}
              {t.channel ? ` ${t.channel}` : ''} · #{t.pack}
            </span>
            {t.size ? (
              <span>
                {t.status === 'completed'
                  ? formatBytes(t.size)
                  : `${formatBytes(t.received)} / ${formatBytes(t.size)}`}
              </span>
            ) : null}
            {t.status === 'downloading' && t.speed > 0 && (
              <>
                <span>{formatSpeed(t.speed)}</span>
                {t.size ? <span>{formatEta((t.size - t.received) / t.speed)} left</span> : null}
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {active && (
            <Tooltip content="Cancel (the partial file is kept, so it can be retried)">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Cancel ${t.filename}`}
                onClick={() => void api.cancelXdcc(t.id).catch(fail)}
              >
                <X />
              </Button>
            </Tooltip>
          )}
          {(t.status === 'error' || t.status === 'cancelled') && (
            <Tooltip content="Try again">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Retry ${t.filename}`}
                onClick={() => void api.retryXdcc(t.id).catch(fail)}
              >
                <RotateCcw />
              </Button>
            </Tooltip>
          )}
          <Tooltip content="Remove from the list">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Remove ${t.filename}`}
              onClick={remove}
            >
              <Trash2 />
            </Button>
          </Tooltip>
        </div>
      </div>
      {t.status !== 'completed' && t.size ? (
        <ProgressBar value={progress} tone={st.bar} label={`${t.filename} progress`} />
      ) : null}
      {(t.error || t.message) && (
        <p
          className={t.error ? 'text-xs text-danger' : 'truncate text-xs text-muted'}
          title={t.error ?? t.message ?? undefined}
        >
          {t.error ?? t.message}
        </p>
      )}
    </li>
  );
}
