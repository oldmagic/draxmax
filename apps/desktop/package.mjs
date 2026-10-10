// Stages a self-contained Electron app for electron-builder:
//   stage/main.js      main process, every JS dependency bundled in
//   stage/preload.cjs  sandboxed preload
//   stage/node_modules only native modules (utp-native, N-API prebuilds) + their deps
// The Web UI and icons are added by electron-builder as extraResources.
import { build } from 'esbuild';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const STAGE = 'stage';
/** Native modules (N-API prebuilds, so they load in Electron) and how to reach them from webtorrent. */
const NATIVE = [
  { name: 'utp-native', via: ['webtorrent'] },
  { name: 'node-datachannel', via: ['webtorrent', '@thaunknown/simple-peer', 'webrtc-polyfill'] },
];
/** Install-time-only dependencies that don't need to ship. */
const SKIP = new Set(['prebuild-install']);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: 'linked',
  legalComments: 'none',
};
await build({
  ...common,
  entryPoints: ['src/main.ts'],
  outfile: `${STAGE}/main.js`,
  format: 'esm',
  external: ['electron', ...NATIVE.map((n) => n.name), 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url); import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);",
  },
});
await build({
  ...common,
  entryPoints: ['src/preload.ts'],
  outfile: `${STAGE}/preload.cjs`,
  format: 'cjs',
  external: ['electron'],
});

/**
 * Finds an installed package directory the way Node would, walking up node_modules folders.
 * Works with pnpm's layout, where a package's dependencies are its siblings.
 */
function findPackageDir(fromDir, name) {
  for (let d = fromDir; ; d = dirname(d)) {
    const candidates = [join(d, 'node_modules', name)];
    if (basename(d) === 'node_modules') candidates.push(join(d, name));
    for (const c of candidates) if (existsSync(join(c, 'package.json'))) return realpathSync(c);
    if (dirname(d) === d) throw new Error(`Cannot find ${name} from ${fromDir}`);
  }
}

/** Copies a package and (recursively) its production dependencies as real directories. */
function copyPackage(name, fromDir, seen) {
  if (seen.has(name) || SKIP.has(name)) return;
  seen.add(name);
  const dir = findPackageDir(fromDir, name);
  cpSync(dir, join(STAGE, 'node_modules', name), { recursive: true, dereference: true });
  const deps = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {};
  for (const dep of Object.keys(deps)) copyPackage(dep, dir, seen);
}

/** Directory of the last package in a dependency chain, e.g. webtorrent → simple-peer → webrtc-polyfill. */
function resolveChain(chain) {
  let dir = process.cwd();
  for (const pkg of chain) dir = findPackageDir(dir, pkg);
  return dir;
}

const seen = new Set();
for (const n of NATIVE) copyPackage(n.name, resolveChain(n.via), seen);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writeFileSync(
  `${STAGE}/package.json`,
  JSON.stringify(
    {
      name: 'draxmax',
      productName: 'DraxMax',
      version: pkg.version,
      description: pkg.description,
      main: 'main.js',
      type: 'module',
      // Placeholder project metadata (required for .deb); replace before publishing.
      author: { name: 'DraxMax contributors', email: 'oldmagic@users.noreply.github.com' },
      homepage: 'https://github.com/oldmagic/draxmax',
      license: 'MIT',
      // Declared so electron-builder packages exactly these (it would otherwise scan the workspace).
      dependencies: Object.fromEntries(
        NATIVE.map((n) => [
          n.name,
          JSON.parse(readFileSync(join(STAGE, 'node_modules', n.name, 'package.json'), 'utf8'))
            .version,
        ]),
      ),
    },
    null,
    2,
  ),
);
console.log('staged desktop app in', STAGE);
