import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Download,
  FolderPlus,
  Gauge,
  HelpCircle,
  KeyRound,
  Loader2,
  Lock,
  LogOut,
  Monitor,
  Moon,
  Network,
  Palette,
  Plus,
  RotateCcw,
  Rss,
  ShieldCheck,
  Sparkles,
  Sun,
  Tags,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { APP_VERSION, type SettingsResponse } from '@draxmax/shared';
import { Badge } from '@/components/ui/badge';
import { BrowseButton, PathInput } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { useTheme, type Theme } from '@/lib/theme';
import { SHORTCUTS } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useAuth } from '@/stores/auth';
import { useUi } from '@/stores/ui';

type S = Record<string, unknown>;

/** Settings query + optimistic PATCH. */
function useSettings() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const mutation = useMutation({
    mutationFn: (patch: S) => api.patchSettings(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['settings'] });
      const prev = qc.getQueryData<SettingsResponse>(['settings']);
      if (prev)
        qc.setQueryData(['settings'], { ...prev, settings: { ...prev.settings, ...patch } });
      return { prev };
    },
    onError: (err, patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(['settings'], ctx.prev);
      toast.error((err as Error).message);
    },
    onSuccess: (data, patch) => {
      qc.setQueryData(['settings'], data);
      const restart = Object.keys(patch).filter((k) => data.restartKeys.includes(k));
      if (restart.length) toast.info('Saved — restart DraxMax to apply');
    },
  });
  return {
    data: query.data,
    save: (patch: S) => mutation.mutate(patch),
    saving: mutation.isPending,
  };
}

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'connection', label: 'Connection', icon: Network },
  { id: 'speed', label: 'Speed', icon: Gauge },
  { id: 'trackers', label: 'Trackers', icon: Tags },
  { id: 'rss', label: 'RSS', icon: Rss },
  { id: 'media', label: 'Upcoming & media', icon: Sparkles },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'security', label: 'Web UI & security', icon: ShieldCheck },
  ...(desktop ? [{ id: 'desktop', label: 'Desktop', icon: Monitor }] : []),
  { id: 'advanced', label: 'Advanced', icon: Wrench },
  { id: 'help', label: 'Help & about', icon: HelpCircle },
] as const;

export function SettingsPage() {
  const { data, save } = useSettings();
  if (!data) return <p className="p-10 text-center text-sm text-muted">Loading settings…</p>;
  const s = data.settings;
  const locked = new Set(data.locked);
  const restart = new Set(data.restartKeys);
  const ctx: FieldCtx = { s, locked, restart, save };

  return (
    <div className="flex h-full flex-col">
      <h1 className="pb-4 text-2xl font-semibold tracking-tight">Settings</h1>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden overflow-y-auto lg:block">
          <ul className="space-y-0.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <a
                  href={`#settings-${id}`}
                  className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-fg"
                >
                  <Icon className="size-4" /> {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-h-0 space-y-6 overflow-y-auto scroll-smooth pb-10 pr-1">
          <Appearance />
          <Section id="downloads" title="Downloads" icon={<Download />}>
            <PathField ctx={ctx} k="downloadPath" label="Default save folder" />
            <NumberField
              ctx={ctx}
              k="maxActiveDownloads"
              label="Maximum active downloads"
              hint="Extra torrents wait in the queue. 0 = no limit."
              min={0}
              max={1000}
            />
            <NumberField
              ctx={ctx}
              k="seedTimeLimitMinutes"
              label="Seeding time limit (minutes)"
              hint="After a finished torrent has seeded this long, it is removed from the list. Its files are kept. Paused time doesn't count. 0 = seed forever."
              min={0}
              max={525600}
            />
            <Categories />
            <RunAs ctx={ctx} identity={data.identity} />
          </Section>
          <Section id="connection" title="Connection" icon={<Network />}>
            <NumberField
              ctx={ctx}
              k="torrentPort"
              label="Listening port (TCP + uTP)"
              hint="0 picks a random port. Forward it in your router for best speeds."
              min={0}
              max={65535}
            />
            <NumberField
              ctx={ctx}
              k="dhtPort"
              label="DHT port (UDP)"
              hint={`Empty = listening port + 1 (currently ${data.effectiveDhtPort}).`}
              min={0}
              max={65535}
              nullable
            />
            <NumberField
              ctx={ctx}
              k="maxConnections"
              label="Maximum connections per torrent"
              min={1}
              max={2000}
            />
            <SwitchField ctx={ctx} k="dht" label="DHT" hint="Find peers without trackers." />
            <SwitchField ctx={ctx} k="pex" label="Peer exchange (PEX)" />
            <SwitchField ctx={ctx} k="lsd" label="Local peer discovery" />
            <SwitchField ctx={ctx} k="upnp" label="UPnP port mapping" />
            <SwitchField ctx={ctx} k="natPmp" label="NAT-PMP port mapping" />
            <SelectField
              ctx={ctx}
              k="encryption"
              label="Encryption"
              options={[
                [0, 'Disabled'],
                [1, 'Prefer encrypted'],
                [2, 'Require encrypted'],
              ]}
            />
            <p className="text-xs text-muted">
              Tip: turn off DHT, PEX and local discovery for private trackers or an anonymous mode.
            </p>
          </Section>
          <Section id="speed" title="Speed limits" icon={<Gauge />}>
            <SpeedField ctx={ctx} k="downloadLimit" label="Download limit" />
            <SpeedField ctx={ctx} k="uploadLimit" label="Upload limit" />
          </Section>
          <Section id="trackers" title="Trackers" icon={<Tags />}>
            <ListField
              ctx={ctx}
              k="defaultTrackers"
              label="Default trackers"
              hint="One announce URL per line."
              mono
            />
            <SwitchField
              ctx={ctx}
              k="addDefaultTrackers"
              label="Add these trackers to every new torrent"
              hint="Helps magnets with few peers; avoid on private trackers."
            />
          </Section>
          <Section id="rss" title="RSS" icon={<Rss />}>
            <SwitchField ctx={ctx} k="rssEnabled" label="Refresh feeds automatically" />
            <NumberField
              ctx={ctx}
              k="rssRefreshMinutes"
              label="Default refresh interval"
              unit="minutes"
              min={5}
              max={1440}
            />
            <NumberField
              ctx={ctx}
              k="rssMaxArticlesPerFeed"
              label="Articles kept per feed"
              min={10}
              max={5000}
            />
            <SwitchField
              ctx={ctx}
              k="missingEnabled"
              label="Download missing episodes automatically"
              hint="Feeds only show the latest releases. This searches for released episodes your rule folders lack (gaps and newer ones) and adds them. See RSS → Missing episodes."
            />
            <NumberField
              ctx={ctx}
              k="missingIntervalHours"
              label="Check followed shows every"
              unit="hours"
              min={1}
              max={168}
            />
            <SwitchField ctx={ctx} k="missingUseNyaa" label="Search Nyaa (anime)" />
            <SwitchField ctx={ctx} k="missingUseAnimeTosho" label="Search AnimeTosho (anime)" />
            <SecretField
              ctx={ctx}
              isSet={data.secretsSet.torznabUrls ?? false}
              k="torznabUrls"
              label="Torznab indexers"
              hint="Prowlarr or Jackett feed URLs including apikey=, separated by spaces. Needed for live-action TV and private trackers."
            />
            <NumberField
              ctx={ctx}
              k="missingMinSeeders"
              label="Minimum seeders"
              min={0}
              max={1000}
            />
            <NumberField
              ctx={ctx}
              k="missingMaxPerRun"
              label="Most torrents added per run"
              min={1}
              max={500}
            />
          </Section>
          <Section id="media" title="Upcoming & media" icon={<Sparkles />}>
            <SecretField
              ctx={ctx}
              isSet={data.secretsSet.tmdbApiKey ?? false}
              k="tmdbApiKey"
              label="TMDB API key"
              hint={
                <>
                  Enables movies and TV in Upcoming. It&apos;s free:{' '}
                  <a
                    className="text-accent hover:underline"
                    href="https://www.themoviedb.org/settings/api"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    get a key
                  </a>
                  . A v3 key or a v4 read access token both work.
                </>
              }
            />
            <SwitchField
              ctx={ctx}
              k="anilistEnabled"
              label="Use AniList for anime"
              hint="Works without an account."
            />
            <ListField
              ctx={ctx}
              k="libraryFolders"
              label="Library folders"
              hint="Folders scanned for shows and movies you already own, one per line. Use Add folder to pick one, or type and edit paths here."
              mono
              folders
            />
            <TextField
              ctx={ctx}
              k="searchUrlTemplate"
              label="Search site for “Search & Add”"
              hint="Use {query} where the title goes, e.g. https://example.org/search?q={query}. Empty = copy the title."
              placeholder="https://…?q={query}"
            />
          </Section>
          <Section id="notifications" title="Notifications" icon={<Bell />}>
            <SwitchField ctx={ctx} k="notifyOnComplete" label="When a download finishes" />
            <SwitchField ctx={ctx} k="notifyOnError" label="When a torrent fails" />
            <SwitchField ctx={ctx} k="notifyOnRssMatch" label="When an RSS rule adds a torrent" />
            <NumberField
              ctx={ctx}
              k="notificationRetentionDays"
              label="Keep notification history for"
              unit="days"
              min={1}
              max={3650}
            />
            <SwitchField
              ctx={ctx}
              k="historyDownload"
              label="Record downloads"
              hint="Added, finished, failed, seeded."
            />
            <SwitchField
              ctx={ctx}
              k="historyRss"
              label="Record RSS and missing episodes"
              hint="Rule downloads, failing feeds and site searches."
            />
            <SwitchField
              ctx={ctx}
              k="historyUpcoming"
              label="Record Upcoming"
              hint="New seasons and sequels of what you have."
            />
            <SwitchField
              ctx={ctx}
              k="historySecurity"
              label="Record security events"
              hint="Sign-ins, failed logins, login changes."
            />
            <SwitchField
              ctx={ctx}
              k="historySystem"
              label="Record system events"
              hint="Settings changes and engine problems."
            />
            {!desktop && <BrowserNotifications />}
          </Section>
          <Security data={data} />
          {desktop && (
            <Section id="desktop" title="Desktop" icon={<Monitor />}>
              <SwitchField
                ctx={ctx}
                k="closeToTray"
                label="Keep running in the tray when the window is closed"
              />
              <SwitchField ctx={ctx} k="startOnLogin" label="Start DraxMax when you log in" />
              <SwitchField ctx={ctx} k="startMinimized" label="Start minimized to the tray" />
            </Section>
          )}
          <Section id="advanced" title="Advanced" icon={<Wrench />}>
            <SelectField
              ctx={ctx}
              k="logLevel"
              label="Log level"
              options={['error', 'warn', 'info', 'debug', 'trace'].map((l) => [
                l,
                l[0]!.toUpperCase() + l.slice(1),
              ])}
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm">First-run setup</div>
              <Button size="sm" onClick={() => save({ firstRunCompleted: false })}>
                <RotateCcw /> Run setup again
              </Button>
            </div>
          </Section>
          <Help />
        </div>
      </div>
    </div>
  );
}

// --- Building blocks --------------------------------------------------------------

interface FieldCtx {
  s: S;
  locked: Set<string>;
  restart: Set<string>;
  save(patch: S): void;
}

function Section({
  id,
  title,
  icon,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-${id}`}
      aria-labelledby={`settings-${id}-title`}
      className="glass scroll-mt-4 rounded-2xl p-5"
    >
      <h2
        id={`settings-${id}-title`}
        className="mb-4 flex items-center gap-2 text-base font-semibold [&_svg]:size-4 [&_svg]:text-muted"
      >
        {icon}
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Label({
  ctx,
  k,
  label,
  hint,
}: {
  ctx: FieldCtx;
  k: string;
  label: string;
  hint?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {label}
        {ctx.locked.has(k) && (
          <Badge tone="muted">
            <Lock className="size-3" /> Set by environment
          </Badge>
        )}
        {ctx.restart.has(k) && <Badge tone="warning">Restart to apply</Badge>}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

function SwitchField({
  ctx,
  k,
  label,
  hint,
}: {
  ctx: FieldCtx;
  k: string;
  label: string;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label ctx={ctx} k={k} label={label} hint={hint} />
      <Switch
        label={label}
        checked={Boolean(ctx.s[k])}
        disabled={ctx.locked.has(k)}
        onChange={(v) => ctx.save({ [k]: v })}
      />
    </div>
  );
}

/** Text-like input that saves on blur / Enter. */
function useDraft(value: string): [string, (v: string) => void] {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  // Adopt server-side changes (adjusting state during render, as React recommends).
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return [draft, setDraft];
}

function NumberField(props: {
  ctx: FieldCtx;
  k: string;
  label: string;
  hint?: ReactNode;
  min: number;
  max: number;
  unit?: string;
  nullable?: boolean;
}) {
  const { ctx, k } = props;
  const value = ctx.s[k];
  const [draft, setDraft] = useDraft(value === undefined || value === null ? '' : String(value));
  const commit = () => {
    if (draft === '' && props.nullable) return value !== undefined && ctx.save({ [k]: null });
    const n = Number(draft);
    if (!Number.isInteger(n) || n < props.min || n > props.max) {
      toast.error(`${props.label}: enter a whole number between ${props.min} and ${props.max}`);
      return setDraft(value === undefined ? '' : String(value));
    }
    if (n !== value) ctx.save({ [k]: n });
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Label ctx={ctx} k={k} label={props.label} hint={props.hint} />
      <div className="flex items-center gap-2">
        <Input
          type="number"
          aria-label={props.label}
          value={draft}
          min={props.min}
          max={props.max}
          disabled={ctx.locked.has(k)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="h-9 w-28"
        />
        {props.unit && <span className="text-sm text-muted">{props.unit}</span>}
      </div>
    </div>
  );
}

function SpeedField({ ctx, k, label }: { ctx: FieldCtx; k: string; label: string }) {
  const bytes = Number(ctx.s[k] ?? -1);
  const [draft, setDraft] = useDraft(bytes > 0 ? String(Math.round(bytes / 1024)) : '');
  const commit = () => {
    const kib = draft.trim() === '' ? 0 : Number(draft);
    if (!Number.isFinite(kib) || kib < 0)
      return toast.error('Enter a positive number, or leave empty for unlimited');
    const next = kib === 0 ? -1 : Math.round(kib * 1024);
    if (next !== bytes) ctx.save({ [k]: next });
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Label ctx={ctx} k={k} label={label} hint="Leave empty for unlimited. Applies immediately." />
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          aria-label={`${label} in KiB/s`}
          placeholder="Unlimited"
          value={draft}
          disabled={ctx.locked.has(k)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="h-9 w-32"
        />
        <span className="text-sm text-muted">KiB/s</span>
      </div>
    </div>
  );
}

function TextField(props: {
  ctx: FieldCtx;
  k: string;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const { ctx, k } = props;
  const [draft, setDraft] = useDraft(String(ctx.s[k] ?? ''));
  const commit = () => draft !== ctx.s[k] && ctx.save({ [k]: draft.trim() });
  return (
    <div className="space-y-1.5">
      <Label ctx={ctx} k={k} label={props.label} hint={props.hint} />
      <Input
        aria-label={props.label}
        value={draft}
        placeholder={props.placeholder}
        disabled={ctx.locked.has(k)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className="h-9"
      />
    </div>
  );
}

function PathField({ ctx, k, label }: { ctx: FieldCtx; k: string; label: string }) {
  const [draft, setDraft] = useDraft(String(ctx.s[k] ?? ''));
  const commit = (v = draft) => v.trim() && v !== ctx.s[k] && ctx.save({ [k]: v.trim() });
  return (
    <div className="space-y-1.5">
      <Label ctx={ctx} k={k} label={label} />
      <div className="flex gap-2">
        <Input
          aria-label={label}
          value={draft}
          disabled={ctx.locked.has(k)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          className="h-9 font-mono text-xs"
        />
        {!ctx.locked.has(k) && (
          <BrowseButton
            value={draft}
            className="h-9"
            onPick={(p) => {
              setDraft(p);
              commit(p);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ListField({
  ctx,
  k,
  label,
  hint,
  mono,
  folders,
}: {
  ctx: FieldCtx;
  k: string;
  label: string;
  hint?: ReactNode;
  mono?: boolean;
  /** Entries are folders: offer an "Add folder" picker that appends to the list. */
  folders?: boolean;
}) {
  const list = (ctx.s[k] as string[] | undefined) ?? [];
  const [draft, setDraft] = useDraft(list.join('\n'));
  const commit = () => {
    const next = draft
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (JSON.stringify(next) !== JSON.stringify(list)) ctx.save({ [k]: next });
  };
  return (
    <div className="space-y-1.5">
      <Label ctx={ctx} k={k} label={label} hint={hint} />
      <Textarea
        aria-label={label}
        value={draft}
        disabled={ctx.locked.has(k)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        wrap={mono ? 'off' : undefined}
        className={cn('min-h-28', mono && 'whitespace-pre font-mono text-xs')}
      />
      {folders && !ctx.locked.has(k) && (
        <div className="flex justify-end">
          <BrowseButton
            value={list.at(-1)}
            className="h-9"
            onPick={(p) => {
              const lines = draft
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean);
              if (lines.includes(p)) return toast.info('That folder is already in the list');
              const next = [...lines, p];
              setDraft(next.join('\n'));
              ctx.save({ [k]: next });
            }}
          >
            <FolderPlus /> Add folder
          </BrowseButton>
        </div>
      )}
    </div>
  );
}

function SelectField({
  ctx,
  k,
  label,
  options,
}: {
  ctx: FieldCtx;
  k: string;
  label: string;
  options: (readonly [string | number, string])[];
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label ctx={ctx} k={k} label={label} />
      <select
        aria-label={label}
        value={String(ctx.s[k])}
        disabled={ctx.locked.has(k)}
        onChange={(e) => {
          const raw = e.target.value;
          const opt = options.find(([v]) => String(v) === raw);
          ctx.save({ [k]: opt ? opt[0] : raw });
        }}
        className="h-9 rounded-xl border bg-surface-2 px-3 text-sm"
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function SecretField({
  ctx,
  k,
  label,
  hint,
  isSet,
}: {
  ctx: FieldCtx;
  k: string;
  label: string;
  hint?: ReactNode;
  isSet: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const locked = ctx.locked.has(k);
  return (
    <div className="space-y-1.5">
      <Label ctx={ctx} k={k} label={label} hint={hint} />
      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) ctx.save({ [k]: value.trim() });
            setValue('');
            setEditing(false);
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label={label}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-9 font-mono text-xs"
            autoFocus
          />
          <Button type="submit" size="sm" variant="primary" className="h-9">
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <span className="flex h-9 flex-1 items-center gap-2 rounded-xl border bg-surface-2 px-3 text-sm text-muted">
            <KeyRound className="size-4" />
            {isSet ? '•••••••••••• (saved, encrypted)' : 'Not set'}
          </span>
          {!locked && (
            <Button size="sm" className="h-9" onClick={() => setEditing(true)}>
              {isSet ? 'Change' : 'Add key'}
            </Button>
          )}
          {isSet && !locked && (
            <Button
              size="sm"
              variant="ghost"
              className="h-9"
              onClick={() => ctx.save({ [k]: null })}
            >
              Remove
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Sections with their own data ------------------------------------------------------

const THEMES: { id: Theme; label: string; icon: typeof Sun }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
];

function Appearance() {
  const [theme, setTheme] = useTheme();
  return (
    <Section id="appearance" title="Appearance" icon={<Palette />}>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
        {THEMES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="radio"
            aria-checked={theme === id}
            onClick={() => setTheme(id)}
            className={cn(
              'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-all',
              theme === id
                ? 'border-accent bg-accent/10 text-fg'
                : 'text-muted hover:bg-surface-hover',
            )}
          >
            <Icon className={cn('size-5', theme === id && 'text-accent')} />
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        The theme is remembered per device. Language: English (more coming).
      </p>
    </Section>
  );
}

function Categories() {
  const qc = useQueryClient();
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['categories'] });
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-sm">Categories</div>
      <div className="text-xs text-muted">
        A category can have its own save folder for new torrents.
      </div>
      <ul className="space-y-1">
        {categories.map((c) => (
          <li
            key={c.name}
            className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm"
          >
            <span className="w-32 shrink-0 truncate font-medium">{c.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">
              {c.savePath ?? 'default folder'}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete category ${c.name}`}
              onClick={() => void api.deleteCategory(c.name).then(refresh)}
            >
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void api
            .saveCategory(name.trim(), path.trim() || null)
            .then(() => {
              setName('');
              setPath('');
              refresh();
            })
            .catch((err: Error) => toast.error(err.message));
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          aria-label="Category name"
          className="h-9 w-36"
        />
        <PathInput
          value={path}
          onChange={setPath}
          placeholder="Save folder (optional)"
          aria-label="Category save folder"
          className="min-w-60 flex-1"
          inputClassName="h-9"
        />
        <Button type="submit" size="sm" className="h-9">
          <Plus /> Add
        </Button>
      </form>
    </div>
  );
}

const fmtAccount = (name: string | null, id: number | null) =>
  id === null ? 'unknown' : name ? `${name} (${id})` : String(id);

/** OS user/group the app runs as, and so the owner of everything it downloads. */
function RunAs({ ctx, identity }: { ctx: FieldCtx; identity: SettingsResponse['identity'] }) {
  const [user, setUser] = useDraft(String(ctx.s.runAsUser ?? ''));
  const [group, setGroup] = useDraft(String(ctx.s.runAsGroup ?? ''));
  const [restarting, setRestarting] = useState(false);
  const dirty = user.trim() !== ctx.s.runAsUser || group.trim() !== ctx.s.runAsGroup;
  const wantUid = ctx.s.runAsUid as number | undefined;
  const wantGid = ctx.s.runAsGid as number | undefined;
  const pending =
    wantUid !== undefined && (wantUid !== identity.uid || (wantGid ?? wantUid) !== identity.gid);

  async function restart() {
    setRestarting(true);
    try {
      await api.restart();
    } catch (e) {
      setRestarting(false);
      return toast.error((e as Error).message);
    }
    toast.info('Restarting DraxMax…');
    // Wait for the old process to go away, then for the new one to answer.
    const started = Date.now();
    let wentDown = false;
    while (Date.now() - started < 120_000) {
      await new Promise((r) => setTimeout(r, 1500));
      const up = await fetch('/api/health').then(
        (r) => r.ok,
        () => false,
      );
      if (!up) wentDown = true;
      else if (wentDown) return location.reload();
    }
    setRestarting(false);
    toast.error('DraxMax did not come back. Check the container logs.');
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <Label
        ctx={ctx}
        k="runAsUser"
        label="Run as user and group"
        hint="New files and folders are owned by this account. Use a name (e.g. oldmagic) or a numeric id; leave empty for the default."
      />
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ctx.save({ runAsUser: user.trim(), runAsGroup: group.trim() });
        }}
      >
        <Input
          aria-label="Run as user"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder="User"
          spellCheck={false}
          className="h-9 w-40 font-mono text-xs"
        />
        <span className="self-center text-muted">:</span>
        <Input
          aria-label="Run as group"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="Group (user's own)"
          spellCheck={false}
          className="h-9 w-44 font-mono text-xs"
        />
        <Button type="submit" size="sm" className="h-9" disabled={!dirty}>
          Save
        </Button>
      </form>
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs">
        <div>
          Running as{' '}
          <span className="font-mono">
            {fmtAccount(identity.user, identity.uid)}:{fmtAccount(identity.group, identity.gid)}
          </span>
          {wantUid !== undefined && !pending && (
            <span className="text-success"> · matches the setting</span>
          )}
        </div>
        {pending && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-warning">
            <span>
              Will run as{' '}
              <span className="font-mono">
                {wantUid}:{wantGid ?? wantUid}
              </span>{' '}
              {identity.canApply
                ? 'after a restart.'
                : '— start DraxMax as root (or in Docker) so it can switch to this account.'}
            </span>
            {identity.canApply && identity.canRestart && (
              <Button
                size="sm"
                className="h-7"
                disabled={restarting}
                onClick={() => void restart()}
              >
                {restarting && <Loader2 className="animate-spin" />} Restart now
              </Button>
            )}
          </div>
        )}
        {identity.docker && (
          <div className="mt-1.5 text-muted">
            In Docker this replaces PUID/PGID. When the ids change, the download folder is re-owned
            once on restart.
          </div>
        )}
      </div>
    </div>
  );
}

function BrowserNotifications() {
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied');
  if (!supported) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t pt-4">
      <div>
        <div className="text-sm">Browser notifications</div>
        <div className="text-xs text-muted">
          {perm === 'granted'
            ? 'Enabled for this browser.'
            : perm === 'denied'
              ? 'Blocked in browser settings.'
              : 'Show system notifications while this tab is open.'}
        </div>
      </div>
      {perm === 'default' && (
        <Button size="sm" onClick={() => void Notification.requestPermission().then(setPerm)}>
          Allow
        </Button>
      )}
    </div>
  );
}

function Security({ data }: { data: SettingsResponse }) {
  const auth = useAuth((s) => s.status);
  const refresh = useAuth((s) => s.refresh);
  const [username, setUsername] = useState(auth?.username ?? 'admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');

  async function saveCredentials() {
    setBusy(true);
    try {
      useAuth
        .getState()
        .set(
          await api.changeCredentials(
            username.trim(),
            password,
            data.authConfigured ? currentPassword : undefined,
          ),
        );
      setPassword('');
      setCurrentPassword('');
      toast.success('Login saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="security" title="Web UI & security" icon={<ShieldCheck />}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm">Login</div>
          <div className="text-xs text-muted">
            {data.authConfigured
              ? `Signed in as ${auth?.username ?? 'admin'}. Other devices must sign in.`
              : 'No login yet: only this computer can use DraxMax. Other devices are asked to create one.'}
          </div>
        </div>
        {data.authConfigured && (
          <Button size="sm" variant="ghost" onClick={() => void api.logout().then(refresh)}>
            <LogOut /> Sign out
          </Button>
        )}
      </div>
      {auth?.managedByEnv ? (
        <p className="rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted">
          <Lock className="mr-1 inline size-3" /> Credentials come from WEBUI_USERNAME /
          WEBUI_PASSWORD.
        </p>
      ) : (
        <form
          className={cn(
            'grid grid-cols-1 gap-2',
            data.authConfigured ? 'sm:grid-cols-[1fr_1fr_1fr_auto]' : 'sm:grid-cols-[1fr_1fr_auto]',
          )}
          onSubmit={(e) => {
            e.preventDefault();
            void saveCredentials();
          }}
        >
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-label="Username"
            autoComplete="username"
            className="h-9"
          />
          {data.authConfigured && (
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              aria-label="Current password"
              autoComplete="current-password"
              required
              className="h-9"
            />
          )}
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password (8+ characters)"
            aria-label="New password"
            autoComplete="new-password"
            minLength={8}
            required
            className="h-9"
          />
          <Button type="submit" size="sm" className="h-9" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {data.authConfigured ? 'Change' : 'Create login'}
          </Button>
        </form>
      )}
      <p className="text-xs text-muted">
        Scripts can use the API with <code className="rounded bg-surface-2 px-1">API_TOKEN</code>{' '}
        set on the server (header{' '}
        <code className="rounded bg-surface-2 px-1">Authorization: Bearer …</code>). Behind an
        authenticating reverse proxy you can set{' '}
        <code className="rounded bg-surface-2 px-1">AUTH_DISABLED=true</code>.
      </p>
    </Section>
  );
}

function Help() {
  const openShortcuts = useUi((s) => s.openShortcuts);
  return (
    <Section id="help" title="Help & about" icon={<HelpCircle />}>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {SHORTCUTS.slice(0, 6).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={openShortcuts}>
          All shortcuts
        </Button>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        <li>
          Slow downloads? Forward your listening port in the router or enable UPnP, and keep DHT on.
        </li>
        <li>In Docker, host networking gives the best connectivity.</li>
        <li>RSS rules apply to new articles and, when saved, to articles already in your feeds.</li>
        <li>Only download content you have the right to share.</li>
      </ul>
      <p className="text-xs text-muted">DraxMax {APP_VERSION}</p>
    </Section>
  );
}
