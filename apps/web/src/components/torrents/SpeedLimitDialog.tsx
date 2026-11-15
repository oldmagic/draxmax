import { ArrowDown, ArrowUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { actions } from '@/lib/actions';
import { useDownloadsUi } from '@/stores/downloads';
import { useTorrents } from '@/stores/torrents';

/** Per-torrent download/upload limits, for one or many torrents. */
export function SpeedLimitDialog() {
  const ids = useDownloadsUi((s) => s.limitIds);
  const close = () => useDownloadsUi.getState().askLimits(null);
  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="Speed limits"
        description={
          ids && ids.length > 1
            ? `${ids.length} torrents. Global limits in Settings still apply.`
            : 'Global limits in Settings still apply.'
        }
      >
        {ids && <SpeedLimitForm ids={ids} onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

/** Bytes/s → the KiB/s text shown in the field ('' = unlimited). */
const toKiB = (bytes: number | undefined) =>
  bytes !== undefined && bytes > 0 ? String(Math.round(bytes / 1024)) : '';

/** The value all targets share, or undefined when they differ. */
function shared(values: number[]): number | undefined {
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

function SpeedLimitForm({ ids, onDone }: { ids: string[]; onDone(): void }) {
  const torrents = useTorrents((s) => s.torrents);
  const targets = torrents.filter((t) => ids.includes(t.id));
  const [down, setDown] = useState(() => toKiB(shared(targets.map((t) => t.downloadLimit))));
  const [up, setUp] = useState(() => toKiB(shared(targets.map((t) => t.uploadLimit))));
  const [busy, setBusy] = useState(false);

  const parse = (text: string) => (text.trim() === '' ? 0 : Number(text));
  const downKiB = parse(down);
  const upKiB = parse(up);
  const invalid = [downKiB, upKiB].some((v) => !Number.isFinite(v) || v < 0);
  const toBytes = (kib: number) => (kib > 0 ? Math.round(kib * 1024) : -1);

  async function apply(downloadLimit: number, uploadLimit: number) {
    setBusy(true);
    await actions.update(ids, { downloadLimit, uploadLimit });
    setBusy(false);
    onDone();
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) void apply(toBytes(downKiB), toBytes(upKiB));
      }}
    >
      <LimitField
        id="limit-down"
        label="Download limit"
        icon={<ArrowDown className="size-4 text-muted" />}
        value={down}
        onChange={setDown}
        autoFocus
      />
      <LimitField
        id="limit-up"
        label="Upload limit"
        icon={<ArrowUp className="size-4 text-muted" />}
        value={up}
        onChange={setUp}
      />
      <p className={invalid ? 'text-xs text-danger' : 'text-xs text-muted'}>
        {invalid
          ? 'Enter a positive number, or leave empty for unlimited.'
          : 'Leave empty for unlimited. Applies immediately.'}
      </p>
      <div className="flex justify-between gap-2 pt-1">
        <Button variant="ghost" disabled={busy} onClick={() => void apply(-1, -1)}>
          Remove limits
        </Button>
        <Button type="submit" variant="primary" disabled={busy || invalid}>
          Apply
        </Button>
      </div>
    </form>
  );
}

function LimitField({
  id,
  label,
  icon,
  value,
  onChange,
  autoFocus,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  value: string;
  onChange(v: string): void;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-medium">
        {icon} {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={0}
          inputMode="numeric"
          placeholder="Unlimited"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          className="h-9 w-32"
        />
        <span className="text-sm text-muted">KiB/s</span>
      </div>
    </div>
  );
}
