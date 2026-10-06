// ── External Dependencies & Registrations
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import Sonda from 'sonda/vite';
import { fileURLToPath, URL } from 'node:url';

// ── DPUse Framework
import { recordShippedPackages } from '@dpuse/dpuse-development/vite';

// ── Data
import config from './config.json' with { type: 'json' };

// ── Vite Configuration ───────────────────────────────────────────────────────────────────────────────────────────────

const viteConfig = defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
            fileName: (format) => `${config.id}.${format}.js`,
            formats: ['es']
        },
        rollupOptions: {
            plugins: [Sonda({ filename: 'index', format: 'json', brotli: false, gzip: true, open: false, outputDir: './bundle-analysis-reports/sonda' })]
        },
        sourcemap: 'hidden',
        target: 'esnext'
    },
    // Tests and config files sit in the tsconfig so they get type-checked, but their declarations must not reach the
    // published package. 'entryRoot' keeps the types under 'dist/types/src', where package.json points.
    // 'recordShippedPackages' writes the record of what the build ships, which 'npm run document' lists licences from.
    plugins: [dts({ entryRoot: '.', exclude: ['tests/**', '*.config.*'], outDirs: 'dist/types' }), recordShippedPackages()],
    resolve: {
        alias: {
            '~': fileURLToPath(new URL('./', import.meta.url)),
            '@': fileURLToPath(new URL('src', import.meta.url))
        }
    }
});

export default viteConfig;
