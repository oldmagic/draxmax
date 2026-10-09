import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Globe,
  KeyRound,
  Loader2,
  Filter,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type {
  SiteDTO,
  SiteField,
  SiteInput,
  SiteMapping,
  SitePresetDTO,
  SiteTestResult,
} from '@draxmax/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Editable copy of a site. Secrets hold only changes: undefined = keep, null = clear. */
interface Draft {
  name: string;
  preset: string | null;
  enabled: boolean;
  baseUrls: string;
  searchUrls: string;
  infoUrl: string;
  downloadUrl: string;
  mapping: SiteMapping;
  mustMatch: string;
  mustNotMatch: string;
  fields: SiteField[];
  values: Record<string, string | null>;
  cookies?: string | null;
  headers?: string | null;
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function fromSite(s: SiteDTO): Draft {
  return {
    name: s.name,
    preset: s.preset,
    enabled: s.enabled,
    baseUrls: s.baseUrls.join('\n'),
    searchUrls: s.searchUrls.join('\n'),
    infoUrl: s.infoUrl,
    downloadUrl: s.downloadUrl,
    mapping: s.mapping,
    mustMatch: s.mustMatch.join('\n'),
    mustNotMatch: s.mustNotMatch.join('\n'),
    fields: s.fields,
    values: {},
  };
}

function fromPreset(p: SitePresetDTO | null): Draft {
  return {
    name: p?.name ?? '',
    preset: p?.id ?? null,
    enabled: true,
    baseUrls: p ? (p.urls[0] ?? '') : '',
    searchUrls: (p?.searchUrls ?? []).join('\n'),
    infoUrl: p?.infoUrl ?? '',
    downloadUrl: p?.downloadUrl ?? '',
    mapping: { format: 'auto' },
    mustMatch: '',
    mustNotMatch: '',
    fields: p?.fields.map(({ name, label, help }) => ({
      name,
      label,
      ...(help ? { help } : {}),
    })) ?? [{ name: 'passkey', label: 'Passkey' }],
    values: {},
  };
}

function toInput(d: Draft): SiteInput {
  // An opened-but-empty secret box means "keep", not "clear" (Remove sends null).
  const values = Object.fromEntries(Object.entries(d.values).filter(([, v]) => v !== ''));
  const keep = (v: string | null | undefined) => (v === '' ? undefined : v);
  const cookies = keep(d.cookies);
  const headers = keep(d.headers);
  return {
    name: d.name.trim(),
    preset: d.preset,
    enabled: d.enabled,
    baseUrls: lines(d.baseUrls),
    searchUrls: lines(d.searchUrls),
    infoUrl: d.infoUrl.trim(),
    downloadUrl: d.downloadUrl.trim(),
    mapping: d.mapping,
    mustMatch: lines(d.mustMatch),
    mustNotMatch: lines(d.mustNotMatch),
    fields: d.fields,
    ...(Object.keys(values).length ? { values } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

export function SitesPage() {
  const { data: sites = [] } = useQuery({ queryKey: ['sites'], queryFn: api.sites });
  const [chosen, setChosen] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<Draft | null>(null);
  const [picking, setPicking] = useState(false);
  const selected = newDraft ? null : (sites.find((s) => s.id === chosen) ?? sites[0] ?? null);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-muted">
            Tracker logins and search pages. Enabled sites are searched for missing episodes, and
            their cookies are sent with RSS feeds and downloads on the same site.
          </p>
        </div>
        <Button variant="primary" onClick={() => setPicking(true)}>
          <Plus /> Add site
        </Button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="glass flex min-h-0 flex-col rounded-2xl p-2">
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" aria-label="Sites">
            {sites.map((s) => (
              <SiteItem
                key={s.id}
                site={s}
                active={!newDraft && selected?.id === s.id}
                onSelect={() => {
                  setNewDraft(null);
                  setChosen(s.id);
                }}
              />
            ))}
            {newDraft && (
              <li className="rounded-xl bg-surface-hover px-3 py-2 text-sm">
                {newDraft.name || 'New site'} <span className="text-xs text-muted">(unsaved)</span>
              </li>
            )}
          </ul>
          {sites.length === 0 && !newDraft && (
            <div className="p-4 text-center text-sm text-muted">
              <Globe className="mx-auto mb-2 size-6" />
              No sites yet.
              <Button size="sm" variant="primary" className="mt-3" onClick={() => setPicking(true)}>
                <Plus /> Add a site
              </Button>
            </div>
          )}
        </aside>
        <section className="glass min-h-0 overflow-y-auto rounded-2xl p-5">
          {newDraft ? (
            <SiteEditor
              key="new"
              site={null}
              initial={newDraft}
              onSaved={(s) => {
                setNewDraft(null);
                setChosen(s.id);
              }}
              onCancel={() => setNewDraft(null)}
            />
          ) : selected ? (
            <SiteEditor
              key={selected.id}
              site={selected}
              initial={fromSite(selected)}
              onSaved={(s) => setChosen(s.id)}
              onCancel={() => setChosen(null)}
            />
          ) : (
            <p className="p-10 text-center text-sm text-muted">Add a site to get started.</p>
          )}
        </section>
      </div>

      <PresetPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(p) => {
          setNewDraft(fromPreset(p));
          setPicking(false);
        }}
      />
    </div>
  );
}

function SiteItem({
  site,
  active,
  onSelect,
}: {
  site: SiteDTO;
  active: boolean;
  onSelect(): void;
}) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.setSiteEnabled(site.id, !site.enabled),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['sites'] }),
  });
  const test = site.lastTest;
  return (
    <li
      className={cn(
        'flex items-center rounded-xl transition-colors',
        active ? 'bg-surface-hover text-fg' : 'text-muted hover:bg-surface-hover hover:text-fg',
      )}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 px-3 py-2 text-left">
        <span className={cn('block truncate text-sm', !site.enabled && 'opacity-60')}>
          {site.name}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted">
          {test ? (
            test.ok ? (
              <>
                <CheckCircle2 className="size-3 text-success" /> {test.total} results in last test
              </>
            ) : (
              <>
                <AlertTriangle className="size-3 text-warning" /> Last test failed
              </>
            )
          ) : (
            'Not tested'
          )}
        </span>
      </button>
      <Switch
        size="sm"
        label={`Enable ${site.name}`}
        checked={site.enabled}
        onChange={() => toggle.mutate()}
        className="mr-3"
      />
    </li>
  );
}

function PresetPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose(): void;
  onPick(p: SitePresetDTO | null): void;
}) {
  const { data: presets = [] } = useQuery({
    queryKey: ['sites', 'presets'],
    queryFn: api.sitePresets,
    staleTime: Infinity,
    enabled: open,
  });
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return presets.filter((p) =>
      words.every((w) => `${p.name} ${p.urls.join(' ')}`.toLowerCase().includes(w)),
    );
  }, [presets, q]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Add a site"
        description="Pick a known site to fill in its links and credential fields, or start from scratch."
        className="w-[min(94vw,36rem)]"
      >
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search sites, e.g. SuperBits"
            aria-label="Search sites"
            className="h-10 pl-9"
          />
        </div>
        <ul className="max-h-80 space-y-0.5 overflow-y-auto rounded-xl bg-surface-2 p-1">
          <li>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-hover"
            >
              <Plus className="size-4 text-accent" /> Custom site
              <span className="text-xs text-muted">enter everything yourself</span>
            </button>
          </li>
          {shown.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p)}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{p.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted">
                    {p.urls[0]}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {p.searchUrls.length > 0 && <Badge tone="success">search</Badge>}
                  <Badge tone="muted">{p.privacy}</Badge>
                </span>
              </button>
            </li>
          ))}
          {presets.length > 0 && shown.length === 0 && (
            <li className="p-6 text-center text-sm text-muted">
              Not in the list: use Custom site.
            </li>
          )}
        </ul>
        <p className="mt-3 text-xs text-muted">
          Site details come from the autobrr indexer definitions. Most only describe links, so add
          the site&apos;s search page yourself if it isn&apos;t filled in.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** Write-only secret: shows whether it's saved; typing replaces it, Remove clears it. */
function SecretBox({
  label,
  hint,
  saved,
  change,
  onChange,
  multiline,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  /** Text describing the stored value ("saved", "2 cookies"), or null when nothing is stored. */
  saved: string | null;
  /** Pending change: undefined = keep, null = clear, string = new value. */
  change: string | null | undefined;
  onChange(v: string | null | undefined): void;
  multiline?: boolean;
  placeholder?: string;
}) {
  const editing = change !== undefined && change !== null;
  const showSaved = saved && change === undefined;
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {showSaved ? (
        <div className="flex items-center gap-2">
          <span className="flex h-9 flex-1 items-center gap-2 rounded-xl border bg-surface-2 px-3 text-sm text-muted">
            <KeyRound className="size-4" /> {saved} (encrypted)
          </span>
          <Button size="sm" className="h-9" onClick={() => onChange('')}>
            Change
          </Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => onChange(null)}>
            Remove
          </Button>
        </div>
      ) : change === null ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          Will be removed on save.
          <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
            Undo
          </Button>
        </div>
      ) : multiline ? (
        <Textarea
          aria-label={label}
          value={editing ? change : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className="min-h-20 font-mono text-xs"
        />
      ) : (
        <Input
          type="password"
          aria-label={label}
          value={editing ? change : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="h-9 font-mono text-xs"
        />
      )}
      {hint && <span className="block text-xs text-muted">{hint}</span>}
    </div>
  );
}

function SiteEditor({
  site,
  initial,
  onSaved,
  onCancel,
}: {
  site: SiteDTO | null;
  initial: Draft;
  onSaved(s: SiteDTO): void;
  onCancel(): void;
}) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(initial);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SiteTestResult | null>(site?.lastTest ?? null);
  const resultRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: (draft: Draft) =>
      site ? api.updateSite(site.id, toInput(draft)) : api.createSite(toInput(draft)),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onSaved(s);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSite(site!.id),
    onSuccess: () => {
      toast.success(`${d.name} removed`);
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onCancel();
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      // Test what's on screen: save pending edits first.
      const saved = !site || dirty ? await save.mutateAsync(d) : site;
      return api.testSite(saved.id, query.trim());
    },
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['sites'] });
      // The results sit at the bottom of a long form: bring them into view.
      requestAnimationFrame(() =>
        resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <form
      className="mx-auto max-w-3xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(d);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{site ? site.name : 'New site'}</h2>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm">
            Enabled{' '}
            <Switch label="Enabled" checked={d.enabled} onChange={(v) => set({ enabled: v })} />
          </span>
          {site && (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() => confirm(`Remove ${site.name} and its saved keys?`) && remove.mutate()}
            >
              <Trash2 /> Remove
            </Button>
          )}
        </div>
      </div>

      <Section title="Site">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input required value={d.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field
            label="Site URL"
            hint="One per line; mirrors are allowed. Links may only point here."
          >
            <Textarea
              required
              value={d.baseUrls}
              onChange={(e) => set({ baseUrls: e.target.value })}
              spellCheck={false}
              className="min-h-10 font-mono text-xs"
              placeholder="https://superbits.org/"
            />
          </Field>
        </div>
      </Section>

      <Section title="Login" icon={<KeyRound className="size-4 text-muted" />}>
        {d.fields.map((f) => (
          <SecretBox
            key={f.name}
            label={f.label}
            hint={f.help ?? `Used as {${f.name}} in links.`}
            saved={site?.secretsSet.values[f.name] ? 'Saved' : null}
            change={d.values[f.name]}
            onChange={(v) => {
              const values = Object.fromEntries(
                Object.entries(d.values).filter(([k]) => k !== f.name),
              );
              set({ values: v === undefined ? values : { ...values, [f.name]: v } });
            }}
          />
        ))}
        <AddField
          existing={d.fields.map((f) => f.name)}
          onAdd={(f) => set({ fields: [...d.fields, f] })}
        />
        <SecretBox
          label="Session cookies"
          hint="Paste the Cookie header from your browser while logged in, or one name=value per line. Needed for search pages that require a login."
          saved={
            site?.secretsSet.cookies
              ? `${site.secretsSet.cookies} ${site.secretsSet.cookies === 1 ? 'cookie' : 'cookies'} saved`
              : null
          }
          change={d.cookies}
          onChange={(v) => set({ cookies: v })}
          multiline
          placeholder={'uid=12345; pass=abcdef…'}
        />
        <SecretBox
          label="Extra headers"
          hint="Optional, one per line, e.g. Authorization: Bearer <api key>."
          saved={
            site?.secretsSet.headers
              ? `${site.secretsSet.headers} ${site.secretsSet.headers === 1 ? 'header' : 'headers'} saved`
              : null
          }
          change={d.headers}
          onChange={(v) => set({ headers: v })}
          multiline
          placeholder="Authorization: Bearer …"
        />
      </Section>

      <Section title="Search and links">
        <Field
          label="Search URLs"
          hint={
            <>
              One per line, with <code>{'{query}'}</code> where the search text goes. They&apos;re
              tried in order until one finds results. Paths may be relative to the site URL.
            </>
          }
        >
          <Textarea
            value={d.searchUrls}
            onChange={(e) => set({ searchUrls: e.target.value })}
            spellCheck={false}
            className="min-h-20 font-mono text-xs"
            placeholder={'/search?search={query}\n/api/v1/torrents?searchText={query}&page=search'}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Torrent page link"
            hint="How a torrent's page link looks; {id} marks the torrent id."
          >
            <Input
              value={d.infoUrl}
              onChange={(e) => set({ infoUrl: e.target.value })}
              className="font-mono text-xs"
              placeholder="/torrent/{id}/"
            />
          </Field>
          <Field label="Download link" hint="{id} and login fields like {passkey} are filled in.">
            <Input
              value={d.downloadUrl}
              onChange={(e) => set({ downloadUrl: e.target.value })}
              className="font-mono text-xs"
              placeholder="/download.php?id={id}&passkey={passkey}"
            />
          </Field>
        </div>
        <details className="rounded-xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Result reading (advanced)
          </summary>
          <p className="mt-2 text-xs text-muted">
            Normally detected automatically. For JSON APIs you can name the fields (dot paths like{' '}
            <code>data.torrents</code>).
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-4">
            <Field label="Format">
              <select
                value={d.mapping.format ?? 'auto'}
                onChange={(e) =>
                  set({
                    mapping: { ...d.mapping, format: e.target.value as SiteMapping['format'] },
                  })
                }
                className="h-9 w-full rounded-xl border bg-surface-2 px-2 text-sm"
              >
                <option value="auto">Auto</option>
                <option value="json">JSON</option>
                <option value="html">HTML page</option>
                <option value="rss">RSS / Torznab</option>
              </select>
            </Field>
            {(['list', 'title', 'id', 'seeders', 'size', 'download', 'groupId'] as const).map(
              (k) => (
                <Field
                  key={k}
                  label={
                    k === 'list'
                      ? 'Result list'
                      : k === 'groupId'
                        ? 'Group id'
                        : k[0]!.toUpperCase() + k.slice(1)
                  }
                >
                  <Input
                    value={d.mapping[k] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value.trim();
                      set({ mapping: { ...d.mapping, [k]: value || undefined } });
                    }}
                    placeholder="auto"
                    className="h-9 font-mono text-xs"
                  />
                </Field>
              ),
            )}
          </div>
        </details>
      </Section>

      <Section title="Release filters" icon={<Filter className="size-4 text-muted" />}>
        <p className="text-xs text-muted">
          Regular expressions (case-insensitive), one per line. They decide which releases this site
          may download; other sites and sources aren&apos;t affected. Test search shows what they
          keep.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Must match"
            hint="A release passes if any line matches. Empty = every release. E.g. only the groups EGEN or NORViNE: -(EGEN|NORViNE)$"
          >
            <Textarea
              value={d.mustMatch}
              onChange={(e) => set({ mustMatch: e.target.value })}
              spellCheck={false}
              className="min-h-20 font-mono text-xs"
              placeholder="-(EGEN|NORViNE)$"
            />
          </Field>
          <Field label="Must not match" hint="Any matching line blocks the release.">
            <Textarea
              value={d.mustNotMatch}
              onChange={(e) => set({ mustNotMatch: e.target.value })}
              spellCheck={false}
              className="min-h-20 font-mono text-xs"
              placeholder={'\\b(HD)?CAM\\b\n\\bTS\\b'}
            />
          </Field>
        </div>
      </Section>

      <div className="flex justify-end gap-2 border-t pt-4">
        {!site && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={save.isPending || (!!site && !dirty)}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {site ? 'Save' : 'Add site'}
        </Button>
      </div>

      <Section title="Test search" icon={<FlaskConical className="size-4 text-muted" />}>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (query.trim()) test.mutate();
              }
            }}
            placeholder="Something the site has, e.g. Frieren"
            aria-label="Test search text"
          />
          <Button
            disabled={
              !query.trim() || test.isPending || !d.name.trim() || !lines(d.baseUrls).length
            }
            onClick={() => test.mutate()}
          >
            {test.isPending ? <Loader2 className="animate-spin" /> : <Search />} Test
          </Button>
        </div>
        {dirty && <p className="text-xs text-muted">Testing saves your changes first.</p>}
        {result && (
          <div ref={resultRef} className="scroll-mt-4">
            <TestResultView
              result={result}
              onUseMapping={
                result.mapping && result.format === 'json'
                  ? () => save.mutate({ ...d, mapping: result.mapping! })
                  : undefined
              }
            />
          </div>
        )}
      </Section>
    </form>
  );
}

function AddField({ existing, onAdd }: { existing: string[]; onAdd(f: SiteField): void }) {
  const [name, setName] = useState('');
  const valid = /^[A-Za-z0-9_]{1,64}$/.test(name) && !existing.includes(name);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-muted">
        Add another login field (rsskey, authkey, …)
      </summary>
      <div className="mt-2 flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder="Field name, e.g. rsskey"
          className="h-9 max-w-xs font-mono text-xs"
          aria-label="New field name"
        />
        <Button
          size="sm"
          className="h-9"
          disabled={!valid}
          onClick={() => {
            onAdd({ name, label: name });
            setName('');
          }}
        >
          <Plus /> Add
        </Button>
      </div>
    </details>
  );
}

function TestResultView({
  result,
  onUseMapping,
}: {
  result: SiteTestResult;
  onUseMapping?: () => void;
}) {
  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={result.ok ? 'success' : 'danger'}>{result.ok ? 'Works' : 'Failed'}</Badge>
        {result.format && <Badge tone="muted">{result.format.toUpperCase()}</Badge>}
        {result.status !== null && <span className="text-xs text-muted">HTTP {result.status}</span>}
        <span className="text-xs text-muted">
          {result.total} results · {new Date(result.at).toLocaleString()}
        </span>
        {onUseMapping && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={onUseMapping}>
            Use these field mappings
          </Button>
        )}
      </div>
      <p className="break-all font-mono text-[11px] text-muted">{result.url}</p>
      {result.error && (
        <p className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {result.error}
        </p>
      )}
      {result.mapping && result.format === 'json' && (
        <p className="font-mono text-[11px] text-muted">
          {Object.entries(result.mapping)
            .filter(([k]) => k !== 'format')
            .map(([k, v]) => `${k}: ${v || '(top level)'}`)
            .join(' · ')}
        </p>
      )}
      {result.results.length > 0 && (
        <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-lg bg-surface-2 text-sm">
          {result.results.map((h, i) => (
            <li
              key={`${h.id}-${i}`}
              className={cn('px-3 py-2', h.filtered !== 'ok' && 'opacity-55')}
            >
              <div className="flex items-center gap-2">
                <span className="truncate" title={h.title}>
                  {h.title}
                </span>
                {h.filtered === 'not-matched' && <Badge tone="muted">not matched</Badge>}
                {h.filtered === 'excluded' && <Badge tone="warning">excluded</Badge>}
              </div>
              <div className="flex flex-wrap gap-x-3 text-xs text-muted">
                {h.id && <span>id {h.id}</span>}
                {h.seeders !== null && <span>{h.seeders} seeders</span>}
                {h.size !== null && <span>{formatBytes(h.size)}</span>}
                <span className="truncate font-mono text-[11px]" title={h.downloadUrl ?? ''}>
                  {h.downloadUrl ?? 'no download link'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {result.excerpt && (
        <details>
          <summary className="cursor-pointer text-xs text-muted">
            Response start (keys hidden)
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 text-[11px]">
            {result.excerpt}
          </pre>
        </details>
      )}
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}
