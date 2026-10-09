import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUp,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Loader2,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { isAbsolutePath } from '@draxmax/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTorrents } from '@/stores/torrents';

export interface Place {
  label: string;
  path: string;
}

/** Folders worth offering: the default, category folders and recently used save paths. */
export function useSavePlaces(): { defaultPath: string | undefined; places: Place[] } {
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const torrents = useTorrents((s) => s.torrents);
  const defaultPath = settings?.settings.downloadPath as string | undefined;

  const places = useMemo(() => {
    const out: Place[] = [];
    const seen = new Set<string>();
    const add = (label: string, path: string | null | undefined) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      out.push({ label, path });
    };
    add('Default', defaultPath);
    for (const c of categories) add(c.name, c.savePath);
    // Most recently added first.
    const recent = [...torrents].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    for (const t of recent) {
      if (out.length >= 12) break;
      add(t.savePath.split(/[\\/]/).filter(Boolean).pop() ?? t.savePath, t.savePath);
    }
    return out;
  }, [defaultPath, categories, torrents]);

  return { defaultPath, places };
}

/** Text field for a save folder, with suggestions and a Browse button. */
export function PathInput({
  value,
  onChange,
  placeholder,
  className,
  inputClassName,
  ...rest
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  'aria-label'?: string;
  id?: string;
}) {
  const listId = useId();
  const { places } = useSavePlaces();
  return (
    <div className={cn('flex gap-2', className)}>
      <Input
        {...rest}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={cn('min-w-0 flex-1 font-mono text-xs', inputClassName)}
      />
      <datalist id={listId}>
        {places.map((p) => (
          <option key={p.path} value={p.path} label={p.label} />
        ))}
      </datalist>
      <BrowseButton
        value={value || (placeholder && isAbsolutePath(placeholder) ? placeholder : undefined)}
        onPick={onChange}
        className={inputClassName}
      />
    </div>
  );
}

/**
 * Opens a folder chooser: the native one in the desktop app (server and UI share a
 * filesystem), otherwise a browser of the server's folders.
 */
export function BrowseButton({
  value,
  onPick,
  className,
  children,
}: {
  value: string | undefined;
  onPick(path: string): void;
  className?: string;
  /** Button content; defaults to a folder icon and "Browse". */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        aria-label={children ? undefined : 'Browse for folder'}
        className={cn('h-10 shrink-0', className)}
        onClick={() => {
          if (desktop?.pickFolder)
            void desktop.pickFolder(value || undefined).then((p) => p && onPick(p));
          else setOpen(true);
        }}
      >
        {children ?? (
          <>
            <FolderOpen /> Browse
          </>
        )}
      </Button>
      {!desktop?.pickFolder && (
        <FolderBrowserDialog
          open={open}
          initialPath={value}
          onClose={() => setOpen(false)}
          onPick={(p) => {
            onPick(p);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

export function FolderBrowserDialog({
  open,
  initialPath,
  onClose,
  onPick,
}: {
  open: boolean;
  initialPath: string | undefined;
  onClose(): void;
  onPick(path: string): void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Choose folder"
        description="Folders on the DraxMax server. Network shares must be mounted there."
        className="w-[min(94vw,36rem)]"
      >
        {/*
          The dialog renders in a portal, but React still bubbles events through the component
          tree: without this, submitting "New folder" (or the path field) also submits the form
          this picker was opened from (Add torrent, rule editor), which closes it.
          Mounted only while open, so it starts from the current value each time.
        */}
        <div
          onSubmit={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.key === 'Enter' && e.stopPropagation()}
        >
          <FolderBrowser initialPath={initialPath} onCancel={onClose} onPick={onPick} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

const joinPath = (base: string, name: string) => {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.endsWith(sep) ? base + name : base + sep + name;
};

function FolderBrowser({
  initialPath,
  onCancel,
  onPick,
}: {
  initialPath: string | undefined;
  onCancel(): void;
  onPick(path: string): void;
}) {
  const qc = useQueryClient();
  const { places } = useSavePlaces();
  const [path, setPath] = useState(initialPath?.trim() || undefined);
  const [typed, setTyped] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ['fs', path ?? ''],
    queryFn: () => api.dirs(path),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const listing = query.isError ? undefined : query.data;
  const shown = typed ?? listing?.path ?? path ?? '';
  // Long paths: keep the current folder's name (the end) in view.
  const pathField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = pathField.current;
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  }, [listing?.path]);

  const go = (p: string) => {
    setTyped(null);
    setNewName(null);
    setPath(p);
  };

  async function createFolder() {
    const name = newName?.trim();
    if (!name || !listing) return;
    if (/[\\/]/.test(name)) return toast.error('Folder names cannot contain slashes');
    setCreating(true);
    try {
      const made = await api.mkdir(joinPath(listing.path, name));
      void qc.invalidateQueries({ queryKey: ['fs'] });
      go(made.path);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (shown.trim()) go(shown.trim());
        }}
      >
        <Button
          size="icon"
          className="size-10 shrink-0"
          aria-label="Parent folder"
          disabled={!listing?.parent}
          onClick={() => listing?.parent && go(listing.parent)}
        >
          <ArrowUp />
        </Button>
        <Input
          ref={pathField}
          aria-label="Folder path"
          value={shown}
          onChange={(e) => setTyped(e.target.value)}
          spellCheck={false}
          className="min-w-0 flex-1 font-mono text-xs"
        />
      </form>

      {places.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {places.map((p) => (
            <button
              key={p.path}
              type="button"
              title={p.path}
              onClick={() => go(p.path)}
              className={cn(
                'flex max-w-[12rem] items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                listing?.path === p.path
                  ? 'bg-accent text-accent-fg'
                  : 'bg-surface-2 text-muted hover:text-fg',
              )}
            >
              <HardDrive className="size-3 shrink-0" />
              <span className="truncate">{p.label}</span>
            </button>
          ))}
        </div>
      )}

      <div
        className="h-64 overflow-y-auto rounded-xl bg-surface-2 p-1"
        aria-busy={query.isFetching}
      >
        {query.isError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm">
            <AlertTriangle className="size-5 text-warning" />
            <span className="break-all">{(query.error as Error).message}</span>
            <span className="text-xs text-muted">
              You can still use this path; it's created when a torrent is saved there.
            </span>
          </div>
        ) : !listing ? (
          <div className="grid h-full place-items-center">
            <Loader2 className="size-5 animate-spin text-muted" aria-label="Loading" />
          </div>
        ) : (
          <ul aria-label="Subfolders">
            {listing.dirs.map((d) => (
              <li key={d}>
                <button
                  type="button"
                  onClick={() => go(joinPath(listing.path, d))}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-hover"
                >
                  <Folder className="size-4 shrink-0 text-accent" />
                  <span className="min-w-0 truncate">{d}</span>
                </button>
              </li>
            ))}
            {listing.dirs.length === 0 && (
              <li className="px-3 py-8 text-center text-xs text-muted">No subfolders.</li>
            )}
          </ul>
        )}
      </div>

      {newName !== null ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void createFolder();
          }}
        >
          <Input
            autoFocus
            aria-label="New folder name"
            placeholder="New folder name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNewName(null);
              }
            }}
            className="h-9 min-w-0 flex-1"
          />
          <Button type="submit" size="sm" className="h-9" disabled={creating || !newName.trim()}>
            {creating && <Loader2 className="animate-spin" />} Create
          </Button>
          <Button size="sm" variant="ghost" className="h-9" onClick={() => setNewName(null)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            {listing && !listing.writable && (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3.5" /> Not writable ·
              </span>
            )}
            {listing?.freeBytes != null && <span>{formatBytes(listing.freeBytes)} free</span>}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            disabled={!listing}
            onClick={() => setNewName('')}
          >
            <FolderPlus /> New folder
          </Button>
        </div>
      )}

      <div className="flex justify-end gap-2 border-t pt-3">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!shown.trim()}
          onClick={() => onPick((typed ?? listing?.path ?? shown).trim())}
        >
          Use this folder
        </Button>
      </div>
    </div>
  );
}
