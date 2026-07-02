// ── External Dependencies & Registrations
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import Sonda from 'sonda/vite';
import { visualizer } from 'rollup-plugin-visualizer';
import { fileURLToPath, URL } from 'node:url';

// ── Data
import config from './config.json';

// ── Vite Configuration ───────────────────────────────────────────────────────────────────────────────────────────────

export default defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
            fileName: (format) => `${config.id}.${format}.js`,
            formats: ['es']
        },
        rollupOptions: {
            plugins: [
                Sonda({ filename: 'index', format: 'html', gzip: true, brotli: true, open: false, outputDir: './bundle-analysis-reports/sonda' }),
                visualizer({ filename: './bundle-analysis-reports/rollup-visualiser/index.html', open: false, gzipSize: true, brotliSize: true }),
                visualizer({ filename: './bundle-analysis-reports/rollup-visualiser/index.json', template: 'raw-data', gzipSize: true, brotliSize: true })
            ]
        },
        sourcemap: true,
        target: 'ESNext'
    },
    plugins: [dts({ outDirs: 'dist/types' })],
    resolve: {
        alias: {
            '~': fileURLToPath(new URL('./', import.meta.url)),
            '@': fileURLToPath(new URL('src', import.meta.url))
        }
    }
});
