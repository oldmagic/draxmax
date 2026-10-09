import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CoreError,
  RESTART_KEYS,
  SECRET_KEYS,
  effectiveDhtPort,
  settingsSchema,
  type Core,
  type Settings,
} from '@draxmax/core';
import type { SettingsResponse } from '@draxmax/shared';
import type { AuthService } from '../auth.ts';
import { currentIdentity, IdentityError, resolveRunAs } from '../identity.ts';

export interface IdentityOptions {
  /** A changed "run as" setting is applied on the next start. */
  canApply: boolean;
  /** Restarts the process (only when something will start it again). */
  restart?: () => void;
}

/** Keys that can't be written through PATCH /api/settings (managed elsewhere). */
const PRIVATE_KEYS = new Set<string>(['webuiPasswordHash', 'runAsUid', 'runAsGid']);
const ALLOWED_KEYS = new Set(Object.keys(settingsSchema.shape).filter((k) => !PRIVATE_KEYS.has(k)));
const SECRETS = new Set<string>(SECRET_KEYS);

/** Settings with secrets blanked, suitable for clients. */
export function settingsResponse(
  core: Core,
  auth: AuthService,
  identity: IdentityOptions = { canApply: false },
): SettingsResponse {
  const s = core.settings.get();
  const visible: Record<string, unknown> = { ...s };
  delete visible.webuiPasswordHash;
  const secretsSet: Record<string, boolean> = {};
  for (const k of SECRET_KEYS) {
    secretsSet[k] = s[k] !== '';
    visible[k] = '';
  }
  return {
    settings: visible,
    locked: core.settings.lockedKeys(),
    restartKeys: RESTART_KEYS,
    secretsSet,
    effectiveDhtPort: effectiveDhtPort(s),
    authConfigured: auth.configured(),
    identity: currentIdentity({ canApply: identity.canApply, canRestart: !!identity.restart }),
  };
}

export async function settingsRoutes(
  app: FastifyInstance,
  { core, auth, identity }: { core: Core; auth: AuthService; identity?: IdentityOptions },
): Promise<void> {
  app.get('/api/settings', async () => settingsResponse(core, auth, identity));

  /**
   * Partial update. Secrets: omit to keep, `null` to clear, string to set.
   * `dhtPort: null` returns it to the derived default.
   */
  app.patch('/api/settings', async (req) => {
    const body = z.record(z.string(), z.unknown()).parse(req.body);
    const locked = new Set(core.settings.lockedKeys());
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(k)) throw new CoreError('invalid_input', `Unknown setting: ${k}`);
      if (locked.has(k as keyof Settings))
        throw new CoreError('invalid_input', `${k} is set by an environment variable`);
      if (SECRETS.has(k)) patch[k] = v === null ? '' : v;
      else if (k === 'dhtPort' && v === null) patch[k] = undefined;
      else patch[k] = v;
    }
    if ('runAsUser' in patch || 'runAsGroup' in patch) {
      const s = core.settings.get();
      const user = String(patch.runAsUser ?? s.runAsUser).trim();
      const group = String(patch.runAsGroup ?? s.runAsGroup).trim();
      try {
        const { uid, gid } = resolveRunAs(user, group);
        patch.runAsUid = uid;
        patch.runAsGid = gid;
      } catch (err) {
        if (err instanceof IdentityError) throw new CoreError('invalid_input', err.message);
        throw err;
      }
    }
    core.settings.update(patch as Partial<Settings>);
    return settingsResponse(core, auth, identity);
  });

  app.post('/api/system/restart', async (_req, reply) => {
    if (!identity?.restart)
      throw new CoreError('invalid_input', 'Restart DraxMax from your service manager');
    // Answer first; the restart closes the server.
    setTimeout(identity.restart, 300).unref();
    return reply.status(202).send({ restarting: true });
  });
}
