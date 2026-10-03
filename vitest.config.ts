// ── External Dependencies & Registrations
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

// ── Vitest Configuration ─────────────────────────────────────────────────────────────────────────────────────────────

const config = defineConfig({
    resolve: {
        alias: {
            '~': fileURLToPath(new URL('./', import.meta.url)),
            '@': fileURLToPath(new URL('src', import.meta.url))
        }
    },
    test: {
        coverage: {
            // 'json' writes the coverage-final.json that `fallow health --coverage` reads; 'json-summary' writes the totals
            // the README's Testing table reports.
            exclude: ['dist/**', 'scripts/**', 'tests/**'],
            include: ['src/**/*.ts'],
            provider: 'v8',
            reporter: ['text', 'json', 'json-summary'],
            reportsDirectory: './coverage'
        },
        globals: true,
        include: ['tests/**/*.test.ts'],
        environment: 'node'
    }
});

export default config;
