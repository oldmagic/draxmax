import * as D from '@radix-ui/react-dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  Loader2,
  Monitor,
  Moon,
  Network,
  Sparkles,
  Sun,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { BrowseButton } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const STEPS = ['Welcome', 'Downloads', 'Network', 'Upcoming'] as const;

/** Four-step first-run setup; shown until `firstRunCompleted` is set. */
export function FirstRunWizard() {
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  if (!data || data.settings.firstRunCompleted !== false) return null;
  return <Wizard initial={data.settings} locked={new Set(data.locked)} />;
}

function Wizard({ initial, locked }: { initial: Record<string, unknown>; locked: Set<string> }) {
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [busy, setBusy] = useState(false);
  const [v, setV] = useState({
    downloadPath: String(initial.downloadPath ?? ''),
    dht: Boolean(initial.dht),
    pex: Boolean(initial.pex),
    lsd: Boolean(initial.lsd),
    upnp: Boolean(initial.upnp),
    addDefaultTrackers: Boolean(initial.addDefaultTrackers),
    anilistEnabled: Boolean(initial.anilistEnabled),
    tmdbApiKey: '',
  });
  const set = (p: Partial<typeof v>) => setV((x) => ({ ...x, ...p }));

  async function finish() {
    setBusy(true);
    try {
      const patch: Record<string, unknown> = { firstRunCompleted: true };
      for (const [k, val] of Object.entries(v)) {
        if (locked.has(k) || (k === 'tmdbApiKey' && !val)) continue;
        if (k === 'downloadPath' && !String(val).trim()) continue;
        patch[k] = val;
      }
      qc.setQueryData(['settings'], await api.patchSettings(patch));
      toast.success("You're all set", {
        description: 'Paste a magnet link anywhere or drop a .torrent file to start.',
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const go = (n: number) => {
    setDir(n > step ? 1 : -1);
    setStep(n);
  };
  const last = step === STEPS.length - 1;

  return (
    <D.Root open>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md" />
        <D.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="glass fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(94vw,36rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-3xl !bg-bg/95"
        >
          <div className="flex items-center gap-2 border-b px-6 py-4">
            {STEPS.map((label, i) => (
              <div key={label} className="flex flex-1 items-center gap-2">
                <span
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold',
                    i < step
                      ? 'bg-success text-white'
                      : i === step
                        ? 'bg-accent text-accent-fg'
                        : 'bg-fg/10 text-muted',
                  )}
                  aria-current={i === step ? 'step' : undefined}
                >
                  {i < step ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    'hidden text-xs sm:inline',
                    i === step ? 'font-medium text-fg' : 'text-muted',
                  )}
                >
                  {label}
                </span>
                {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
              </div>
            ))}
          </div>

          <div className="relative min-h-[22rem] overflow-y-auto px-6 py-6">
            <AnimatePresence mode="wait" custom={dir}>
              <motion.div
                key={step}
                custom={dir}
                initial={{ opacity: 0, x: dir * 24 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: dir * -24 }}
                transition={{ duration: 0.18 }}
              >
                {step === 0 && (
                  <Step
                    icon={<img src="/favicon.svg" alt="" className="size-9" />}
                    title="Welcome to DraxMax"
                    text="A fast, modern BitTorrent client. This takes under a minute — every choice can be changed later in Settings."
                  >
                    <div className="text-sm font-medium">Choose a look</div>
                    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
                      {(
                        [
                          ['system', 'System', Monitor],
                          ['light', 'Light', Sun],
                          ['dark', 'Dark', Moon],
                        ] as [Theme, string, typeof Sun][]
                      ).map(([id, label, Icon]) => (
                        <button
                          key={id}
                          role="radio"
                          aria-checked={theme === id}
                          onClick={() => setTheme(id)}
                          className={cn(
                            'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-all',
                            theme === id
                              ? 'border-accent bg-accent/10'
                              : 'text-muted hover:bg-surface-hover',
                          )}
                        >
                          <Icon className={cn('size-5', theme === id && 'text-accent')} />
                          {label}
                        </button>
                      ))}
                    </div>
                  </Step>
                )}
                {step === 1 && (
                  <Step
                    icon={<Download className="size-8 text-accent" />}
                    title="Where should downloads go?"
                    text="New torrents are saved here unless a category says otherwise."
                  >
                    <div className="flex gap-2">
                      <Input
                        value={v.downloadPath}
                        onChange={(e) => set({ downloadPath: e.target.value })}
                        disabled={locked.has('downloadPath')}
                        aria-label="Download folder"
                        className="font-mono text-xs"
                      />
                      {!locked.has('downloadPath') && (
                        <BrowseButton
                          value={v.downloadPath}
                          onPick={(p) => set({ downloadPath: p })}
                        />
                      )}
                    </div>
                    {locked.has('downloadPath') && (
                      <p className="text-xs text-muted">
                        Set by the DOWNLOAD_PATH environment variable.
                      </p>
                    )}
                  </Step>
                )}
                {step === 2 && (
                  <Step
                    icon={<Network className="size-8 text-accent" />}
                    title="Finding peers"
                    text="The defaults work for most people."
                  >
                    <Toggle
                      label="DHT"
                      hint="Find peers without trackers (recommended)."
                      checked={v.dht}
                      disabled={locked.has('dht')}
                      onChange={(x) => set({ dht: x })}
                    />
                    <Toggle
                      label="Peer exchange & local discovery"
                      hint="Learn peers from other peers and your local network."
                      checked={v.pex && v.lsd}
                      disabled={locked.has('pex')}
                      onChange={(x) => set({ pex: x, lsd: x })}
                    />
                    <Toggle
                      label="Automatic port forwarding (UPnP)"
                      hint="Lets other peers connect to you through your router."
                      checked={v.upnp}
                      disabled={locked.has('upnp')}
                      onChange={(x) => set({ upnp: x })}
                    />
                    <Toggle
                      label="Add public trackers to new torrents"
                      hint="More peers for magnets; leave off for private trackers."
                      checked={v.addDefaultTrackers}
                      onChange={(x) => set({ addDefaultTrackers: x })}
                    />
                  </Step>
                )}
                {step === 3 && (
                  <Step
                    icon={<Sparkles className="size-8 text-accent" />}
                    title="Upcoming releases (optional)"
                    text="DraxMax can suggest new seasons, sequels and releases related to what you download."
                  >
                    <Toggle
                      label="Anime from AniList"
                      hint="No account needed."
                      checked={v.anilistEnabled}
                      onChange={(x) => set({ anilistEnabled: x })}
                    />
                    <label className="block space-y-1.5">
                      <span className="text-sm">TMDB API key for movies & TV</span>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={v.tmdbApiKey}
                        onChange={(e) => set({ tmdbApiKey: e.target.value })}
                        placeholder="Optional — paste your key"
                        disabled={locked.has('tmdbApiKey')}
                      />
                      <span className="block text-xs text-muted">
                        Free at{' '}
                        <a
                          className="text-accent hover:underline"
                          href="https://www.themoviedb.org/settings/api"
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          themoviedb.org
                        </a>
                        . Stored encrypted on this machine.
                      </span>
                    </label>
                  </Step>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex items-center justify-between gap-2 border-t px-6 py-4">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => go(step - 1)}>
                <ArrowLeft /> Back
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => void finish()}>
                Skip setup
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => (last ? void finish() : go(step + 1))}
              disabled={busy}
            >
              {busy && <Loader2 className="animate-spin" />}
              {last ? 'Start using DraxMax' : 'Continue'}
              {!last && <ArrowRight />}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Step({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent-2/20">
        {icon}
      </div>
      <div>
        <D.Title className="text-xl font-semibold tracking-tight">{title}</D.Title>
        <D.Description className="mt-1 text-sm text-muted">{text}</D.Description>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl bg-surface-2 px-4 py-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}
