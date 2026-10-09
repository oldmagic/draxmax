import { QueryClientProvider } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { Redirect, Route, Switch, useLocation } from 'wouter';
import { AddTorrentDialog } from '@/components/AddTorrentDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { FirstRunWizard } from '@/components/FirstRunWizard';
import { Shortcuts } from '@/components/Shortcuts';
import { GlobalDrop } from '@/components/GlobalDrop';
import { MobileNav, Sidebar } from '@/components/Sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { queryClient } from '@/lib/query';
import { useSystemThemeSync, useTheme } from '@/lib/theme';
import { AuthScreen } from '@/pages/Auth';
import { DownloadsPage } from '@/pages/Downloads';
import { RssPage } from '@/pages/Rss';
import { SitesPage } from '@/pages/Sites';
import { SettingsPage } from '@/pages/Settings';
import { StatsPage } from '@/pages/Stats';
import { UpcomingPage } from '@/pages/Upcoming';
import { useAuth } from '@/stores/auth';
import { startLiveFeed } from '@/stores/torrents';

export function App() {
  const [theme] = useTheme();
  useSystemThemeSync();
  const status = useAuth((s) => s.status);

  useEffect(() => {
    void useAuth.getState().refresh();
  }, []);

  let content;
  if (!status) {
    content = (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-6 animate-spin text-muted" aria-label="Loading" />
      </div>
    );
  } else if (!status.authenticated) {
    content = <AuthScreen mode={status.setupRequired ? 'setup' : 'login'} />;
  } else {
    content = <Shell />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        {content}
        <Toaster
          theme={theme}
          position="bottom-right"
          toastOptions={{ className: '!glass !rounded-xl !text-fg !border-border' }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function Shell() {
  const [location] = useLocation();
  useEffect(() => startLiveFeed(), []);

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-xl focus:bg-bg focus:px-4 focus:py-2 focus:shadow-glass"
      >
        Skip to content
      </a>
      <div className="flex h-full">
        <Sidebar />
        <main id="main" className="min-w-0 flex-1 overflow-hidden p-3 pb-24 md:p-6 md:pb-6">
          <AnimatePresence mode="wait">
            <motion.div
              key={location}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="h-full"
            >
              <ErrorBoundary resetKey={location}>
                <Switch>
                  <Route path="/">
                    <Redirect to="/downloads" />
                  </Route>
                  <Route path="/downloads" component={DownloadsPage} />
                  <Route path="/upcoming" component={UpcomingPage} />
                  <Route path="/rss" component={RssPage} />
                  <Route path="/sites" component={SitesPage} />
                  <Route path="/stats" component={StatsPage} />
                  <Route path="/settings" component={SettingsPage} />
                  <Route>
                    <Redirect to="/downloads" />
                  </Route>
                </Switch>
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </main>
        <MobileNav />
      </div>
      <AddTorrentDialog />
      <GlobalDrop />
      <Shortcuts />
      <FirstRunWizard />
    </>
  );
}
