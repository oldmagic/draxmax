import { useEffect } from 'react';
import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';
const KEY = 'draxmax-theme';

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function apply(theme: Theme): void {
  const dark =
    theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

const useThemeStore = create<{ theme: Theme; set(t: Theme): void }>((set) => ({
  theme: read(),
  set: (theme) => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // Storage unavailable: preference lasts for this session only.
    }
    apply(theme);
    set({ theme });
  },
}));

/** Theme preference persisted per browser; "system" follows the OS live. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.set);
  return [theme, setTheme];
}

/** Mount once: keeps "system" in sync with OS changes. */
export function useSystemThemeSync(): void {
  const theme = useThemeStore((s) => s.theme);
  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
}
