import { cn } from '@/lib/utils';

const tones = {
  accent: 'bg-gradient-to-r from-accent to-accent-2',
  success: 'bg-success',
  muted: 'bg-muted/50',
  danger: 'bg-danger',
  warning: 'bg-warning',
} as const;

export type ProgressTone = keyof typeof tones;

interface ProgressBarProps {
  value: number;
  tone?: ProgressTone;
  className?: string;
  label?: string;
}

/** Thin animated progress bar (value 0–1). */
export function ProgressBar({ value, tone = 'accent', className, label }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-fg/8', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-700 ease-out', tones[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Circular progress ring for card views and compact indicators. */
export function ProgressRing({
  value,
  size = 40,
  stroke = 4,
  tone = 'accent',
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: ProgressTone;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  const color = {
    accent: 'var(--accent)',
    success: 'var(--success)',
    muted: 'var(--muted)',
    danger: 'var(--danger)',
    warning: 'var(--warning)',
  }[tone];
  return (
    <svg width={size} height={size} className="-rotate-90" aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.1}
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        className="transition-[stroke-dashoffset] duration-700 ease-out"
      />
    </svg>
  );
}
