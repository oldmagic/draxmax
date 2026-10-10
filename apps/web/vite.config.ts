import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/**
 * Writes `.br` and `.gz` next to every text asset, so the server sends them as they are
 * (@fastify/static `preCompressed`) and never spends CPU compressing at request time.
 */
function precompress(): Plugin {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  let outDir = 'dist';
  return {
    name: 'draxmax-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const file of walk(outDir)) {
        if (!/\.(js|css|html|svg|json|map)$/.test(file)) continue;
        const data = readFileSync(file);
        if (data.length < 1024) continue;
        writeFileSync(
          `${file}.br`,
          brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        );
        writeFileSync(`${file}.gz`, gzipSync(data, { level: 9 }));
      }
    },
  };
}

const apiTarget = process.env.DRAXMAX_API ?? 'http://127.0.0.1:8895';

export default defineConfig({
  plugins: [react(), tailwindcss(), precompress()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
  },
});
