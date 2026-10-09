import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { StatsSample } from '@draxmax/shared';
import { formatSpeed } from '@/lib/format';

const H = 260;
const PAD = { top: 16, right: 80, bottom: 28, left: 64 };

const SERIES = [
  { key: 'down', label: 'Download', color: 'var(--series-1)' },
  { key: 'up', label: 'Upload', color: 'var(--series-2)' },
] as const;

/** "Nice" axis maximum and step for bytes/s values. */
function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1024, ticks: [0, 256, 512, 768, 1024] };
  const raw = max / 4;
  const pow = 1024 ** Math.floor(Math.log(raw) / Math.log(1024));
  const unit = raw / pow;
  const step =
    ([1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => s >= unit) ?? 1000) * pow;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

function timeLabel(t: number, step: number): string {
  const d = new Date(t);
  return step >= 60
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
}

/**
 * Download/upload speed over time: two 2px lines on one bytes/s axis, a crosshair that
 * snaps to the nearest sample with a tooltip listing both series, legend + end labels,
 * and a table view for non-visual access.
 */
export function SpeedChart({
  samples,
  step,
  title,
}: {
  samples: StatsSample[];
  step: number;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  // Chart units are real pixels so text stays legible at any width. A callback ref
  // re-attaches the observer when the placeholder is swapped for the chart.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [W, setW] = useState(800);
  useEffect(() => {
    if (!box) return;
    const ro = new ResizeObserver(([entry]) =>
      setW(Math.max(300, Math.round(entry!.contentRect.width))),
    );
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const geo = useMemo(() => {
    if (samples.length < 2) return null;
    const t0 = samples[0]!.t;
    const t1 = samples[samples.length - 1]!.t;
    const { top, ticks } = niceScale(Math.max(...samples.map((s) => Math.max(s.down, s.up))));
    const x = (t: number) =>
      PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
    const y = (v: number) => H - PAD.bottom - (v / top) * (H - PAD.top - PAD.bottom);
    const path = (key: 'down' | 'up') =>
      samples
        .map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`)
        .join('');
    const n = W < 500 ? 3 : 5;
    const xTicks = Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
    return { x, y, ticks, xTicks, path, top };
  }, [samples, W]);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    if (!geo || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let dist = Infinity;
    samples.forEach((s, i) => {
      const d = Math.abs(geo.x(s.t) - px);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    setHover(best);
  }

  const last = samples[samples.length - 1];
  const h = hover !== null ? samples[hover] : null;

  return (
    <figure className="space-y-3">
      <figcaption className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm font-semibold">{title}</span>
        <div className="flex items-center gap-4 text-xs text-muted">
          {SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span
                className="h-0.5 w-4 rounded-full"
                style={{ background: s.color }}
                aria-hidden
              />
              {s.label}
            </span>
          ))}
          <button
            type="button"
            onClick={() => setTable((v) => !v)}
            className="font-medium text-accent hover:underline"
          >
            {table ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </figcaption>

      {table ? (
        <div className="max-h-64 overflow-y-auto rounded-xl border">
          <table className="w-full text-xs tabular">
            <thead className="sticky top-0 bg-bg text-left text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                <th className="px-3 py-2 text-right font-medium">Download</th>
                <th className="px-3 py-2 text-right font-medium">Upload</th>
              </tr>
            </thead>
            <tbody>
              {[...samples].reverse().map((s) => (
                <tr key={s.t} className="border-t">
                  <td className="px-3 py-1.5">{new Date(s.t).toLocaleTimeString()}</td>
                  <td className="px-3 py-1.5 text-right">{formatSpeed(s.down)}</td>
                  <td className="px-3 py-1.5 text-right">{formatSpeed(s.up)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !geo ? (
        <div className="grid h-[260px] place-items-center rounded-xl text-sm text-muted">
          Collecting data…
        </div>
      ) : (
        <div ref={setBox} className="relative">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full touch-none select-none"
            role="img"
            aria-label={`${title}. Latest: download ${formatSpeed(last!.down)}, upload ${formatSpeed(last!.up)}.`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {/* Recessive grid and y axis */}
            {geo.ticks.map((v) => (
              <g key={v}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={geo.y(v)}
                  y2={geo.y(v)}
                  stroke="currentColor"
                  strokeOpacity={v === 0 ? 0.25 : 0.08}
                />
                <text
                  x={PAD.left - 8}
                  y={geo.y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-[var(--muted)] text-[11px] tabular"
                >
                  {v === 0 ? '0' : formatSpeed(v)}
                </text>
              </g>
            ))}
            {geo.xTicks.map((t, i) => (
              <text
                key={i}
                x={geo.x(t)}
                y={H - 8}
                textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}
                className="fill-[var(--muted)] text-[11px] tabular"
              >
                {timeLabel(t, step)}
              </text>
            ))}
            {SERIES.map((s) => (
              <path
                key={s.key}
                d={geo.path(s.key)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
            {/* Direct end labels (text ink, colored marker carries identity) */}
            {SERIES.map((s, i) => {
              const yPos = geo.y(last![s.key]);
              const other = geo.y(last![SERIES[1 - i]!.key]);
              const nudge = Math.abs(yPos - other) < 14 ? (yPos <= other ? -7 : 7) : 0;
              return (
                <g key={s.key}>
                  <circle
                    cx={geo.x(last!.t)}
                    cy={yPos}
                    r={4}
                    fill={s.color}
                    stroke="var(--bg)"
                    strokeWidth={2}
                  />
                  <text
                    x={geo.x(last!.t) + 8}
                    y={yPos + nudge}
                    dy="0.32em"
                    className="fill-[var(--fg)] text-[11px] font-medium"
                  >
                    {s.label === 'Download' ? '↓' : '↑'} {formatSpeed(last![s.key])}
                  </text>
                </g>
              );
            })}
            {h && (
              <g pointerEvents="none">
                <line
                  x1={geo.x(h.t)}
                  x2={geo.x(h.t)}
                  y1={PAD.top}
                  y2={H - PAD.bottom}
                  stroke="currentColor"
                  strokeOpacity={0.35}
                />
                {SERIES.map((s) => (
                  <circle
                    key={s.key}
                    cx={geo.x(h.t)}
                    cy={geo.y(h[s.key])}
                    r={4}
                    fill={s.color}
                    stroke="var(--bg)"
                    strokeWidth={2}
                  />
                ))}
              </g>
            )}
          </svg>
          {h && geo && (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-xl border bg-bg/95 px-3 py-2 text-xs shadow-glass"
              style={{
                left: `${(geo.x(h.t) / W) * 100}%`,
                transform:
                  geo.x(h.t) > W / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
              }}
              role="status"
            >
              <div className="mb-1 font-medium">{new Date(h.t).toLocaleTimeString()}</div>
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center gap-2 tabular">
                  <span
                    className="h-0.5 w-3 rounded-full"
                    style={{ background: s.color }}
                    aria-hidden
                  />
                  <span className="text-muted">{s.label}</span>
                  <span className="ml-auto pl-3 font-medium">{formatSpeed(h[s.key])}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
