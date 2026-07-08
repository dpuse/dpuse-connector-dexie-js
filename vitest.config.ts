// ── External Dependencies & Registrations
import { defineConfig } from 'vitest/config';
import path from 'node:path';

// ── Vitest Configuration ─────────────────────────────────────────────────────────────────────────────────────────────

export default defineConfig({
    resolve: {
        alias: {
            '~': path.resolve(__dirname, './'),
            '@': path.resolve(__dirname, './src')
        }
    },
    test: {
        globals: true,
        include: ['tests/**/*.test.ts'],
        environment: 'node'
    }
});
