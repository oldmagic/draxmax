import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, type AuthService } from '../auth.ts';

const credentials = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});
const newCredentials = credentials.extend({
  password: z.string().min(8, 'Use at least 8 characters').max(1024),
});

export async function authRoutes(
  app: FastifyInstance,
  { auth }: { auth: AuthService },
): Promise<void> {
  app.get('/api/auth/status', async (req) => auth.status(req));

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = credentials.parse(req.body);
    const sid = auth.login(req, username, password);
    if (sid === 'rate_limited')
      return reply.status(429).send({ error: 'Too many attempts. Try again in a minute.' });
    if (!sid) return reply.status(401).send({ error: 'Wrong username or password' });
    auth.setCookie(req, reply, sid);
    return auth.status(req);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(req);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  /**
   * First-time credentials while no login exists. From this machine it just works; from
   * anywhere else it needs the one-time setup code printed in the server log.
   */
  app.post('/api/auth/setup', async (req, reply) => {
    if (auth.configured()) return reply.status(409).send({ error: 'A login already exists' });
    const { username, password, setupCode } = newCredentials
      .extend({ setupCode: z.string().max(64).optional() })
      .parse(req.body);
    if (!auth.setupAllowed(req, setupCode))
      return reply.status(403).send({
        error: setupCode
          ? 'Wrong setup code'
          : 'Enter the setup code from the DraxMax log (docker logs draxmax)',
        setupCodeRequired: true,
      });
    auth.setCredentials(username, password);
    const sid = auth.createSession();
    auth.setCookie(req, reply, sid);
    req.cookies[SESSION_COOKIE] = sid;
    return auth.status(req);
  });

  /** Change credentials (requires an authorized request; enforced by the global hook). */
  app.put('/api/auth/credentials', async (req, reply) => {
    const { username, password, currentPassword } = newCredentials
      .extend({ currentPassword: z.string().max(1024).optional() })
      .parse(req.body);
    const check = auth.confirmCurrent(req, currentPassword);
    if (check !== 'ok')
      return reply.status(check === 'rate_limited' ? 429 : 403).send({
        error:
          check === 'rate_limited'
            ? 'Too many attempts. Try again in a minute.'
            : 'Current password is wrong',
      });
    auth.setCredentials(username, password);
    const sid = auth.createSession();
    auth.setCookie(req, reply, sid);
    req.cookies[SESSION_COOKIE] = sid;
    return auth.status(req);
  });

  app.delete('/api/auth/credentials', async (req, reply) => {
    // Removing the login opens the API to this machine without one; only do it from here.
    if (!auth.isLocal(req) && !auth.isTokenRequest(req))
      return reply
        .status(403)
        .send({ error: 'The login can only be removed on the DraxMax machine itself' });
    auth.clearCredentials();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });
}
