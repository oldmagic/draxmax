import { readFileSync } from 'node:fs';
import type { ProcessIdentity } from '@draxmax/shared';

/**
 * Account databases to resolve names against. In Docker the host's files can be mounted
 * at /host/etc (see docker-compose.yml), since the container has its own users.
 */
const dbDirs = () =>
  [process.env.ACCOUNTS_DIR, '/host/etc', '/etc'].filter((d): d is string => !!d);

interface Entry {
  name: string;
  id: number;
  /** Primary group (passwd only). */
  gid?: number;
}

function readDb(file: 'passwd' | 'group'): { entries: Entry[]; source: string } | null {
  for (const dir of dbDirs()) {
    let text: string;
    try {
      text = readFileSync(`${dir}/${file}`, 'utf8');
    } catch {
      continue;
    }
    const entries = text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(':'))
      .filter((f) => f.length >= 4 && /^\d+$/.test(f[2]!))
      .map((f): Entry => ({
        name: f[0]!,
        id: Number(f[2]),
        ...(file === 'passwd' ? { gid: Number(f[3]) } : {}),
      }));
    return { entries, source: dir };
  }
  return null;
}

const byName = (db: Entry[] | undefined, name: string) => db?.find((e) => e.name === name);
const byId = (db: Entry[] | undefined, id: number) => db?.find((e) => e.id === id);

export class IdentityError extends Error {}

/**
 * Resolves the "run as" settings to numeric ids. Numeric input is accepted as-is; a user
 * without a group uses that user's primary group. Throws {@link IdentityError} for names
 * that aren't known.
 */
export function resolveRunAs(
  user: string,
  group: string,
): { uid: number | undefined; gid: number | undefined } {
  const passwd = readDb('passwd');
  const groups = readDb('group');
  const hint =
    process.env.DRAXMAX_DOCKER === '1'
      ? ' Use numeric ids, or mount the host’s /etc/passwd and /etc/group at /host/etc (see docker-compose.yml).'
      : '';

  let uid: number | undefined;
  let primaryGid: number | undefined;
  if (user) {
    if (/^\d+$/.test(user)) {
      uid = Number(user);
      primaryGid = byId(passwd?.entries, uid)?.gid;
    } else {
      const e = byName(passwd?.entries, user);
      if (!e) throw new IdentityError(`Unknown user "${user}".${hint}`);
      uid = e.id;
      primaryGid = e.gid;
    }
  }

  let gid: number | undefined;
  if (group) {
    if (/^\d+$/.test(group)) gid = Number(group);
    else {
      const e = byName(groups?.entries, group);
      if (!e) throw new IdentityError(`Unknown group "${group}".${hint}`);
      gid = e.id;
    }
  } else gid = primaryGid ?? uid;
  return { uid, gid };
}

/** Who the server process runs as now, and whether a changed setting can be applied. */
export function currentIdentity(opts: { canApply: boolean; canRestart: boolean }): ProcessIdentity {
  const uid = process.getuid?.() ?? null;
  const gid = process.getgid?.() ?? null;
  const passwd = readDb('passwd');
  const groups = readDb('group');
  return {
    uid,
    gid,
    user: uid === null ? null : (byId(passwd?.entries, uid)?.name ?? null),
    group: gid === null ? null : (byId(groups?.entries, gid)?.name ?? null),
    docker: process.env.DRAXMAX_DOCKER === '1',
    canApply: opts.canApply,
    canRestart: opts.canRestart,
  };
}
