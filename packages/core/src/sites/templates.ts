/**
 * URL templates for sites: `{name}` placeholders, each value URL-encoded on substitution.
 * Variables: `query` (search text), `id` (torrent id), `releaseName`/`title`, `groupId`,
 * and every credential field (passkey, rsskey, authkey, torrent_pass, …).
 */

export class TemplateError extends Error {}

const PLACEHOLDER = /\{([A-Za-z0-9_.]+)\}/g;

/** Placeholder names used in a template. */
export function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Fills a template; throws {@link TemplateError} naming any variable without a value. */
export function fill(template: string, vars: Record<string, string | number | undefined>): string {
  const missing = placeholders(template).filter((n) => vars[n] === undefined || vars[n] === '');
  if (missing.length)
    throw new TemplateError(`No value for {${[...new Set(missing)].join('}, {')}}`);
  return template.replace(PLACEHOLDER, (_, n: string) => encodeURIComponent(String(vars[n])));
}

/** Resolves a (possibly relative) filled template against a base URL. */
export function resolveUrl(
  template: string,
  base: string,
  vars: Record<string, string | number | undefined>,
): string {
  return new URL(fill(template, vars), base).toString();
}

/**
 * Turns a torrent-page template into a regex that finds such links in HTML and captures the
 * id (`/torrent/{id}/` → /\/torrent\/(?<id>\d+)\/?/). Other placeholders match one path or
 * query segment. Works for absolute and relative hrefs.
 */
export function templateToRegex(template: string): RegExp | null {
  if (!template.includes('{id}')) return null;
  let path = template;
  try {
    // Absolute templates: keep only path + query, hrefs may be relative.
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path.replace(PLACEHOLDER, 'PLACEHOLDER_$1'));
      path = (u.pathname + u.search).replace(/PLACEHOLDER_([A-Za-z0-9_.]+)/g, '{$1}');
    }
  } catch {
    return null;
  }
  let first = true;
  const source = path
    .split(PLACEHOLDER)
    .map((part, i) => {
      // Literal text; "&" may be written "&amp;" in HTML.
      if (i % 2 === 0)
        return part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/&/g, '(?:&|&amp;)');
      if (part === 'id' && first) {
        first = false;
        return '(?<id>[A-Za-z0-9_-]+)';
      }
      return '[^/?&#"\'<>]*';
    })
    .join('')
    // A trailing slash is optional; the leading one may be missing in relative links
    // ("torrents.php?id=1"), but the path must still start there or right after a "/".
    .replace(/\\\/$/, '\\/?')
    .replace(/^\\\//, '(?:^|\\/)');
  return new RegExp(source);
}

/** Every value that must never appear in logs or excerpts. */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets.filter((x) => x.length >= 4))
    out = out.split(s).join('•••').split(encodeURIComponent(s)).join('•••');
  return out;
}
