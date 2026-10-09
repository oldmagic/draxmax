// Bundles the headless server into dist/server.js. Workspace packages (TS source) are
// inlined; third-party packages stay external and are installed in the runtime image.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'externalize-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@draxmax/') ? undefined : { path: args.path, external: true },
        );
      },
    },
  ],
});
console.log('built dist/server.js');
