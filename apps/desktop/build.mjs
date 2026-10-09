// Bundles the Electron main process (ESM) and preload (CJS: required for sandboxed preloads).
// Workspace packages are inlined; third-party packages stay external.
import { build } from 'esbuild';

const externalizeDeps = {
  name: 'externalize-deps',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith('@draxmax/') ? undefined : { path: args.path, external: true },
    );
  },
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  plugins: [externalizeDeps],
};

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.js',
    format: 'esm',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
  }),
  build({ ...common, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', format: 'cjs' }),
]);
console.log('built dist/main.js, dist/preload.cjs');
