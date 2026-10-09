import { join } from 'node:path';
import { isAbsolutePath, ruleSchema, type RuleInput } from '@draxmax/shared';
import { RuleSyntaxError, validateRule } from './rules.ts';

/** A rule from a qBittorrent export, converted but not yet bound to local feed ids. */
export interface QbRule {
  input: Omit<RuleInput, 'assignedFeedIds'>;
  /** qBittorrent's `affectedFeeds` (feed URLs). */
  feedUrls: string[];
  lastMatchAt: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Converts a qBittorrent RSS rules export (the JSON written by "Export rules…", or
 * `rss/download_rules.json`). Handles both the legacy flat fields and the `torrentParams`
 * block of qBittorrent ≥ 4.6. Relative save paths are resolved against `defaultSavePath`,
 * as qBittorrent does.
 */
export function parseQbRules(
  json: Record<string, unknown>,
  defaultSavePath: string,
): { rules: QbRule[]; errors: { name: string; error: string }[] } {
  const rules: QbRule[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const [rawName, value] of Object.entries(json)) {
    const name = rawName.trim().slice(0, 200) || 'Imported rule';
    if (!isObj(value)) {
      errors.push({ name, error: 'Not a rule object' });
      continue;
    }
    const params = isObj(value.torrentParams) ? value.torrentParams : {};

    let savePath = str(params.save_path) || str(value.savePath);
    if (savePath && !isAbsolutePath(savePath)) savePath = join(defaultSavePath, savePath);
    const paused = params.stopped ?? params.paused ?? value.addPaused;
    const tags = Array.isArray(params.tags) ? params.tags.map(str).filter(Boolean) : [];
    const ignoreDays = typeof value.ignoreDays === 'number' ? value.ignoreDays : 0;
    const lastMatch = Date.parse(str(value.lastMatch));

    const parsed = ruleSchema.safeParse({
      name,
      enabled: value.enabled !== false,
      priority: typeof value.priority === 'number' ? Math.max(0, value.priority) : 0,
      mustContain: str(value.mustContain) ? [str(value.mustContain)] : [],
      mustNotContain: str(value.mustNotContain) ? [str(value.mustNotContain)] : [],
      useRegex: value.useRegex === true,
      episodeFilter: str(value.episodeFilter) || undefined,
      smartEpisodeFilter: value.smartFilter === true,
      ignoreSubsequentDays: ignoreDays > 0 ? Math.min(365, Math.round(ignoreDays)) : undefined,
      category: str(params.category) || str(value.assignedCategory) || undefined,
      tags,
      savePath: savePath || undefined,
      addPaused: paused === true,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({ name, error: `${issue?.path.join('.')}: ${issue?.message}` });
      continue;
    }
    try {
      validateRule(parsed.data);
    } catch (err) {
      if (!(err instanceof RuleSyntaxError)) throw err;
      errors.push({ name, error: err.message });
      continue;
    }
    const { assignedFeedIds: _ignored, ...input } = parsed.data;
    rules.push({
      input,
      feedUrls: Array.isArray(value.affectedFeeds)
        ? [...new Set(value.affectedFeeds.map(str).filter(Boolean))]
        : [],
      lastMatchAt: Number.isNaN(lastMatch) ? null : new Date(lastMatch).toISOString(),
    });
  }
  return { rules, errors };
}
