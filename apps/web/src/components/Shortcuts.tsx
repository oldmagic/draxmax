import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { SHORTCUTS } from '@/lib/shortcuts';
import { useUi } from '@/stores/ui';

const GO: Record<string, string> = {
  d: '/downloads',
  u: '/upcoming',
  r: '/rss',
  i: '/sites',
  s: '/stats',
  ',': '/settings',
};

/** Global keyboard shortcuts (outside text fields) and the "?" help dialog. */
export function Shortcuts() {
  const { shortcutsOpen, openShortcuts, closeShortcuts, openAdd } = useUi();
  const [, navigate] = useLocation();

  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
        )
      )
        return;
      if (e.key === '?') {
        e.preventDefault();
        openShortcuts();
      } else if (e.key === 'n') {
        e.preventDefault();
        openAdd();
      } else if (e.key === 'g') {
        pendingG = Date.now();
      } else if (Date.now() - pendingG < 1200 && GO[e.key]) {
        navigate(GO[e.key]!);
        pendingG = 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, openAdd, openShortcuts]);

  return (
    <Dialog open={shortcutsOpen} onOpenChange={(o) => !o && closeShortcuts()}>
      <DialogContent title="Keyboard shortcuts">
        <dl className="divide-y divide-border/60">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4 py-2 text-sm">
              <dt>
                <kbd className="rounded-md border bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                  {k}
                </kbd>
              </dt>
              <dd className="text-right text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
