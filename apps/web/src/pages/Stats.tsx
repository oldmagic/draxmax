import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  HardDrive,
  Loader,
  Network,
  Radio,
  Users,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { SpeedChart } from '@/components/charts/SpeedChart';
import { api } from '@/lib/api';
import { formatBytes, formatSpeed } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useStats } from '@/stores/stats';

function Tile({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('glass rounded-2xl px-4 py-3.5', className)}>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted tabular">{sub}</div>}
    </div>
  );
}

function Panel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="glass rounded-2xl p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-muted">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value, icon }: { label: string; value: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="flex items-center gap-2 text-muted [&_svg]:size-4">
        {icon}
        {label}
      </span>
      <span className="font-medium tabular">{value}</span>
    </div>
  );
}

export function StatsPage() {
  const latest = useStats((s) => s.latest);
  const live = useStats((s) => s.live);
  const [range, setRange] = useState<'live' | 'day'>('live');
  const initial = useQuery({
    queryKey: ['stats', 'snapshot'],
    queryFn: api.stats,
    enabled: !latest,
  });
  const history = useQuery({
    queryKey: ['stats', 'history', range],
    queryFn: () => api.statsHistory(range),
    refetchInterval: range === 'day' ? 60_000 : false,
  });

  // Seed the live buffer with server history so the chart isn't empty on first visit.
  useEffect(() => {
    if (range === 'live' && history.data) useStats.getState().seed(history.data.samples);
  }, [history.data, range]);

  const s = latest ?? initial.data;
  if (!s) return <p className="p-10 text-center text-sm text-muted">Loading statistics…</p>;

  const samples = range === 'live' ? live : (history.data?.samples ?? []);
  const diskUsedPct = s.disk ? 1 - s.disk.free / s.disk.total : 0;

  return (
    <div className="h-full space-y-4 overflow-y-auto pb-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Stats</h1>
        <p className="mt-1 text-sm text-muted">
          Session started {new Date(s.session.startedAt).toLocaleString()}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Download speed"
          value={formatSpeed(s.downloadSpeed)}
          sub={`${s.torrents.downloading} downloading`}
        />
        <Tile
          label="Upload speed"
          value={formatSpeed(s.uploadSpeed)}
          sub={`${s.torrents.seeding} seeding`}
        />
        <Tile
          label="Session"
          value={formatBytes(s.session.downloaded)}
          sub={`↑ ${formatBytes(s.session.uploaded)} · ratio ${s.session.ratio.toFixed(2)}`}
        />
        <Tile
          label="All time"
          value={formatBytes(s.allTime.downloaded)}
          sub={`↑ ${formatBytes(s.allTime.uploaded)} · ratio ${s.allTime.ratio.toFixed(2)}`}
        />
      </div>

      <section className="glass rounded-2xl p-4">
        <div className="mb-2 flex justify-end">
          <div
            role="radiogroup"
            aria-label="Time range"
            className="flex rounded-xl border bg-surface-2 p-0.5 text-xs"
          >
            {(
              [
                ['live', 'Last 5 minutes'],
                ['day', 'Last 24 hours'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                role="radio"
                aria-checked={range === v}
                onClick={() => setRange(v)}
                className={cn(
                  'rounded-lg px-3 py-1.5 font-medium',
                  range === v ? 'bg-bg text-fg shadow-sm' : 'text-muted hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <SpeedChart
          samples={samples}
          step={range === 'live' ? 1 : 60}
          title={range === 'live' ? 'Transfer speed (live)' : 'Transfer speed, per-minute average'}
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Torrents" icon={<Radio />}>
          <Row label="Total" value={s.torrents.total} />
          <Row label="Downloading" value={s.torrents.downloading} />
          <Row label="Seeding" value={s.torrents.seeding} />
          <Row label="Queued" value={s.torrents.queued} />
          <Row label="Paused" value={s.torrents.paused} />
          <Row label="Checking" value={s.torrents.checking} />
          <Row
            label="Errors"
            value={s.torrents.error}
            icon={s.torrents.error ? <AlertCircle className="text-danger" /> : undefined}
          />
        </Panel>

        <Panel title="Network health" icon={<Network />}>
          <Row label="Connected peers" value={`${s.peers} (${s.seeds} seeds)`} icon={<Users />} />
          <Row label="DHT nodes" value={s.dhtNodes} />
          <div className="mt-2 border-t pt-2 text-xs font-medium text-muted">Trackers</div>
          <Row
            label="Working"
            value={s.trackers.working}
            icon={<CheckCircle2 className="text-success" />}
          />
          <Row
            label="Updating"
            value={s.trackers.updating}
            icon={<Loader className="text-info" />}
          />
          <Row
            label="Not working"
            value={s.trackers.notWorking}
            icon={<AlertCircle className="text-danger" />}
          />
          <Row label="Disabled" value={s.trackers.disabled} icon={<CircleSlash />} />
        </Panel>

        <Panel title="Disk" icon={<HardDrive />}>
          {s.disk ? (
            <>
              <div className="mb-1 truncate font-mono text-xs text-muted" title={s.disk.path}>
                {s.disk.path}
              </div>
              <div
                role="meter"
                aria-label="Disk usage"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(diskUsedPct * 100)}
                className="my-3 h-2 overflow-hidden rounded-full bg-fg/10"
              >
                <div
                  className={cn(
                    'h-full rounded-full',
                    diskUsedPct > 0.9 ? 'bg-danger' : 'bg-accent',
                  )}
                  style={{ width: `${diskUsedPct * 100}%` }}
                />
              </div>
              <Row label="Free" value={formatBytes(s.disk.free)} />
              <Row label="Total" value={formatBytes(s.disk.total)} />
              <Row label="Used by torrents" value={formatBytes(s.disk.usedByTorrents)} />
            </>
          ) : (
            <p className="text-sm text-muted">Disk information unavailable.</p>
          )}
        </Panel>
      </div>

      <Panel title="Top bandwidth consumers" icon={<Users />}>
        {s.top.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted">Nothing is transferring right now.</p>
        ) : (
          <table className="w-full text-sm tabular">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="pb-2 font-medium">Torrent</th>
                <th className="pb-2 text-right font-medium">Download</th>
                <th className="pb-2 text-right font-medium">Upload</th>
              </tr>
            </thead>
            <tbody>
              {s.top.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="max-w-0 truncate py-2 pr-3">{t.name}</td>
                  <td className="py-2 text-right">{formatSpeed(t.downloadSpeed)}</td>
                  <td className="py-2 text-right">{formatSpeed(t.uploadSpeed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
