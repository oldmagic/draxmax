import { FileUp } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { MAGNET_RE } from '@draxmax/shared';
import { actions } from '@/lib/actions';
import { useUi } from '@/stores/ui';

/**
 * App-wide shortcuts: drop .torrent files anywhere to add them; paste a magnet link
 * anywhere (outside text fields) to open the add dialog prefilled.
 */
export function GlobalDrop() {
  const [dragDepth, setDragDepth] = useState(0);
  const openAdd = useUi((s) => s.openAdd);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const enter = (e: DragEvent) => hasFiles(e) && setDragDepth((d) => d + 1);
    const leave = (e: DragEvent) => hasFiles(e) && setDragDepth((d) => Math.max(0, d - 1));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth(0);
      void actions.addFiles([...(e.dataTransfer?.files ?? [])]);
    };
    const paste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = e.clipboardData?.getData('text')?.trim() ?? '';
      if (MAGNET_RE.test(text)) {
        e.preventDefault();
        openAdd(text);
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, [openAdd]);

  return (
    <AnimatePresence>
      {dragDepth > 0 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-accent/10 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            className="glass flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed !border-accent px-14 py-10"
          >
            <FileUp className="size-10 text-accent" />
            <p className="text-lg font-semibold">Drop to add torrents</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
