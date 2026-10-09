import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { actions } from '@/lib/actions';
import { useDownloadsUi } from '@/stores/downloads';
import { useTorrents } from '@/stores/torrents';

export function RemoveDialog() {
  const ids = useDownloadsUi((s) => s.removeIds);
  const close = () => useDownloadsUi.getState().askRemove(null);
  // Select the stable array and derive here: a selector returning a fresh array loops forever.
  const torrents = useTorrents((s) => s.torrents);
  const names = useMemo(
    () => torrents.filter((t) => ids?.includes(t.id)).map((t) => t.name),
    [torrents, ids],
  );
  const [deleteFiles, setDeleteFiles] = useState(false);

  async function confirm() {
    if (!ids) return;
    await actions.remove(ids, deleteFiles);
    const ui = useDownloadsUi.getState();
    ui.setSelection([...ui.selected].filter((id) => !ids.includes(id)));
    if (ui.detailId && ids.includes(ui.detailId)) ui.closeDetail();
    setDeleteFiles(false);
    close();
  }

  const many = (ids?.length ?? 0) > 1;
  return (
    <Dialog open={ids !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent
        title={many ? `Remove ${ids!.length} torrents?` : 'Remove torrent?'}
        description={
          many
            ? names.slice(0, 3).join(', ') +
              (names.length > 3 ? ` and ${names.length - 3} more` : '')
            : names[0]
        }
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-surface-hover">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--danger)]"
          />
          <span className="text-sm">
            <span className="font-medium">Also delete downloaded files</span>
            <span className="mt-0.5 block text-muted">
              This permanently removes the data from disk.
            </span>
          </span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()}>
            {deleteFiles ? 'Remove and delete files' : 'Remove'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
