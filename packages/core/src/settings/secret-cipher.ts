import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { SecretCipher } from './settings.ts';

/**
 * AES-256-GCM cipher keyed by a random file next to the settings (`secret.key`, mode 0600).
 * Protects secrets in settings.json backups and accidental shares; it is not a defence
 * against someone who can read the whole config directory.
 */
export function fileKeyCipher(keyPath: string): SecretCipher {
  let key: Buffer;
  if (existsSync(keyPath)) {
    key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
  } else {
    key = randomBytes(32);
    writeFileSync(keyPath, key.toString('base64'), { mode: 0o600 });
  }
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Non-POSIX filesystem: best effort.
  }
  if (key.length !== 32) throw new Error(`Invalid secret key file: ${keyPath}`);

  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    decrypt(sealed) {
      const buf = Buffer.from(sealed, 'base64');
      const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
    },
  };
}
