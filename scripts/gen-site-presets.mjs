#!/usr/bin/env node
/**
 * Generates packages/core/src/sites/presets.json from the autobrr indexer definitions
 * (https://github.com/autobrr/autobrr, internal/indexer/definitions) at a pinned commit.
 *
 * Only site facts are kept: name, URLs, privacy, the credential fields a user must enter
 * and the torrent-page / download link templates. IRC settings, announce regexes and
 * test data are not copied. Run: `node scripts/gen-site-presets.mjs`.
 */
import { writeFileSync } from 'node:fs';
import yaml from 'js-yaml';

const COMMIT = '478be9a9e9f9a92d046f13136c5daa30b6008ab1';
const BASE = `https://raw.githubusercontent.com/autobrr/autobrr/${COMMIT}/internal/indexer/definitions`;
const OUT = new URL('../packages/core/src/sites/presets.json', import.meta.url);

// The repository's file list at that commit (the GitHub listing API isn't always reachable).
const NAMES =
  `0dayfiles abnormal acidlounge aither alpharatio animebytes animeworld ant bemaniso beyondhd
bit-hdtv bithumen bitsexy bjshare brokenstones btfiles btn capybarabr cathode-ray-tube czteam danishbits
danishbytes darkpeers dasunerwartete digitalcore dirtybytes docspedia emp enthralled f1carreras fappaizuri
filelist finelite funfile fuzer gazellegames happyfappy hd-space hd-torrents hdb hdonly hebits homiehelpdesk
huno immortalseed infinityhd insane iplay iptorrents itatorrents keepfrds locadora lst luminarr materialize
midnightscene milkie myanonamouse ncore nebulance norbits nordicbytes nordicquality nyaa onlyencodes orpheus
pbay peergarden phoenixproject pixelhd polishtracker privatesilverscreen ptfiles ptm ptp pussytorrents
rastastugan red reelflix retroflix retromoviesclub retrotoonworld revolutiontt rocket-hd samaritano
satclubbing scenehd seedcore seedpool seedpool_music shareisland sharewood simurg skipthecommercials speedapp
subsplease sugoimusic superbits t66y thedarkcommunity torrentbytes torrentday torrentleech torrentnetwork
torrentsyndikat trancetraffic uploadcx xspeeds xwt`
    .split(/\s+/)
    .filter(Boolean);

/** Search pages we know (the definitions only describe announces, not search). */
const SEARCH = {
  superbits: [
    '/search?search={query}',
    '/api/v1/torrents?extendedSearch=false&freeleech=false&index=0&limit=50&order=asc&page=search&searchText={query}&section=all&sort=n',
  ],
  nyaa: ['/?page=rss&c=1_0&f=0&q={query}'],
  subsplease: [],
};

/** `{{ .torrentId }}` → `{id}`, `{{ .passkey }}` → `{passkey}`; other variables keep their names. */
export function convertTemplate(t) {
  return String(t ?? '')
    .replace(/\{\{\s*\.torrentId\s*\}\}/g, '{id}')
    .replace(/\{\{\s*\.([A-Za-z0-9_.]+)\s*(\|[^}]*)?\}\}/g, (_, v) => `{${v}}`);
}

/** The first `match` block with link templates (usually irc.channels[].parse.match). */
function findMatch(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.match && (node.match.downloadurl || node.match.torrenturl || node.match.infourl))
    return node.match;
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const m = findMatch(v);
    if (m) return m;
  }
  return null;
}

async function load(name) {
  const res = await fetch(`${BASE}/${name}.yaml`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return yaml.load(await res.text());
}

const presets = [];
for (const name of NAMES) {
  let d;
  try {
    d = await load(name);
  } catch (err) {
    console.warn(`skip ${name}: ${err.message}`);
    continue;
  }
  const match = findMatch(d) ?? {};
  const urls = (d.urls ?? []).filter((u) => /^https?:\/\//.test(u));
  if (!urls.length) continue;
  const fields = (d.settings ?? [])
    .filter((s) => s?.name && !String(s.name).includes('.'))
    .map((s) => ({
      name: String(s.name),
      label: String(s.label ?? s.name),
      ...(s.help ? { help: String(s.help).trim().slice(0, 300) } : {}),
      secret: s.type === 'secret',
    }));
  presets.push({
    id: String(d.identifier ?? name),
    name: String(d.name ?? name),
    privacy: String(d.privacy ?? 'private'),
    urls,
    fields,
    infoUrl: convertTemplate(match.infourl),
    downloadUrl: convertTemplate(match.downloadurl ?? match.torrenturl),
    searchUrls: SEARCH[name] ?? [],
  });
}
presets.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      source: `autobrr/autobrr@${COMMIT} internal/indexer/definitions (site facts only)`,
      presets,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${presets.length} presets`);
