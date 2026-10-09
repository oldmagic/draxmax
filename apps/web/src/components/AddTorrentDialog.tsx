import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FileUp, FolderDown, Link2, Loader2 } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { isAbsolutePath, MAGNET_RE } from '@draxmax/shared';
import { PathInput, useSavePlaces } from '@/components/FolderPicker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { actions } from '@/lib/actions';
import { api } from '@/lib/api';
import { desktop } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import { useUi } from '@/stores/ui';

/** Accepts one or more magnet links (one per line) or .torrent files. */
export function AddTorrentDialog() {
  const { addOpen, addPrefill, closeAdd } = useUi();
  return (
    <Dialog open={addOpen} onOpenChange={(o) => !o && closeAdd()}>
      <DialogContent title="Add torrents" description="Paste magnet links or drop .torrent files.">
        {/* Content unmounts when closed, so the form starts fresh from the prefill each time. */}
        <AddTorrentForm initialText={addPrefill} onDone={closeAdd} />
      </DialogContent>
    </Dialog>
  );
}

function AddTorrentForm({ initialText, onDone }: { initialText: string; onDone(): void }) {
  const closeAdd = onDone;
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [paused, setPaused] = useState(false);
  const [sequential, setSequential] = useState(false);
  const [savePath, setSavePath] = useState('');
  const { data: categories = [] } = useQuery({ queryKey: ['categories'], queryFn: api.categories });
  const { defaultPath } = useSavePlaces();
  // Where torrents go when no folder is chosen: the category's folder, else the default.
  const fallbackPath =
    categories.find((c) => c.name === category.trim())?.savePath ?? defaultPath ?? '';
  const pathInvalid = savePath.trim() !== '' && !isAbsolutePath(savePath.trim());
  const extra = {
    savePath: savePath.trim() || undefined,
    category: category.trim() || undefined,
    tags: tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    paused,
    sequential,
  };

  const magnets = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = magnets.filter((m) => !MAGNET_RE.test(m));

  async function submitMagnets() {
    if (magnets.length === 0 || invalid.length > 0 || pathInvalid) return;
    setBusy(true);
    let ok = 0;
    for (const m of magnets) if (await actions.addMagnet(m, extra)) ok++;
    setBusy(false);
    if (ok === magnets.length) closeAdd();
  }

  async function addFiles(files: File[]) {
    if (pathInvalid) return;
    setBusy(true);
    const added = await actions.addFiles(files, extra);
    setBusy(false);
    if (added > 0) closeAdd();
  }

  async function pick() {
    if (pathInvalid) return;
    if (desktop) {
      const files = await desktop.pickTorrentFiles();
      if (files.length === 0) return;
      setBusy(true);
      await actions.addBase64(files, extra);
      setBusy(false);
      closeAdd();
    } else {
      fileInput.current?.click();
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    void addFiles([...e.dataTransfer.files]);
  }

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
          <Link2 className="size-4 text-muted" /> Magnet links
        </span>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitMagnets();
          }}
          placeholder="magnet:?xt=urn:btih:…  (one per line)"
          className="font-mono text-xs"
          aria-invalid={invalid.length > 0}
        />
        {invalid.length > 0 && (
          <span className="mt-1 block text-xs text-danger">
            {invalid.length === 1 ? 'One line is' : `${invalid.length} lines are`} not a magnet
            link.
          </span>
        )}
      </label>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
          dragging ? 'border-accent bg-accent/10' : 'border-border',
        )}
      >
        <FileUp className={cn('size-6', dragging ? 'text-accent' : 'text-muted')} />
        <p className="text-sm text-muted">
          Drop <span className="font-medium text-fg">.torrent</span> files here or{' '}
          <button
            type="button"
            onClick={() => void pick()}
            className="font-medium text-accent hover:underline"
          >
            browse
          </button>
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".torrent,application/x-bittorrent"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
      </div>

      <div>
        <label
          htmlFor="add-save-path"
          className="mb-1.5 flex items-center gap-1.5 text-sm font-medium"
        >
          <FolderDown className="size-4 text-muted" /> Save to
        </label>
        <PathInput
          id="add-save-path"
          value={savePath}
          onChange={setSavePath}
          placeholder={fallbackPath}
          inputClassName="h-9"
        />
        <span className={cn('mt-1 block text-xs', pathInvalid ? 'text-danger' : 'text-muted')}>
          {pathInvalid
            ? 'Use a full path, e.g. /mnt/nas/Movies.'
            : savePath.trim()
              ? 'Overrides the default and category folder for these torrents.'
              : 'Leave empty to use the default or category folder.'}
        </span>
      </div>

      <div className="rounded-xl border">
        <button
          type="button"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium"
        >
          Options
          <ChevronDown
            className={cn('size-4 text-muted transition-transform', showOptions && 'rotate-180')}
          />
        </button>
        {showOptions && (
          <div className="grid gap-3 border-t p-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted">Category</span>
              <Input
                list="add-categories"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="None"
                className="h-9"
              />
              <datalist id="add-categories">
                {categories.map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-muted">Tags (comma-separated)</span>
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. linux, iso"
                className="h-9"
              />
            </label>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
              Start paused
              <Switch label="Start paused" checked={paused} onChange={setPaused} />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
              Sequential download
              <Switch label="Sequential download" checked={sequential} onChange={setSequential} />
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={closeAdd}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submitMagnets()}
          disabled={busy || magnets.length === 0 || invalid.length > 0 || pathInvalid}
        >
          {busy && <Loader2 className="animate-spin" />}
          Add {magnets.length > 1 ? `${magnets.length} torrents` : 'torrent'}
        </Button>
      </div>
    </div>
  );
}
