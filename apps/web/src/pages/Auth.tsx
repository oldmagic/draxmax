import { Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/stores/auth';

/** Login screen, or first-run "secure your Web UI" when no credentials exist yet. */
export function AuthScreen({ mode }: { mode: 'login' | 'setup' }) {
  const setStatus = useAuth((s) => s.set);
  const needsCode = useAuth((s) => s.status?.setupCodeRequired ?? false);
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState(mode === 'setup' ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'setup' && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      setStatus(
        mode === 'setup'
          ? await api.setupAuth(username, password, needsCode ? setupCode : undefined)
          : await api.login(username, password),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const Icon = mode === 'setup' ? ShieldCheck : LockKeyhole;
  return (
    <div className="grid min-h-full place-items-center p-4">
      <form
        onSubmit={(e) => void submit(e)}
        className="glass w-full max-w-sm space-y-4 rounded-3xl p-7"
      >
        <div className="flex flex-col items-center gap-3 pb-2 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent/25 to-accent-2/25">
            <Icon className="size-7 text-accent" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {mode === 'setup' ? 'Secure your DraxMax' : 'Sign in to DraxMax'}
          </h1>
          <p className="text-sm text-muted">
            {mode === 'setup'
              ? 'You are connecting from another device. Create a login so only you can control this client.'
              : 'Enter your Web UI credentials.'}
          </p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Username</span>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            autoFocus={mode === 'login'}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Password</span>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            minLength={mode === 'setup' ? 8 : 1}
            required
            autoFocus={mode === 'setup'}
          />
        </label>
        {mode === 'setup' && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Confirm password</span>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
        )}
        {mode === 'setup' && needsCode && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Setup code</span>
            <Input
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              autoComplete="one-time-code"
              spellCheck={false}
              required
              className="font-mono uppercase"
            />
            <span className="block text-xs text-muted">
              Shown in the DraxMax log, e.g. <code>docker logs draxmax</code>. It proves you own
              this server.
            </span>
          </label>
        )}
        {error && (
          <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />}
          {mode === 'setup' ? 'Create login' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
