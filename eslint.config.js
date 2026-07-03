// ── External Dependencies & Registrations
import { dpuseESLintConfig } from '@dpuse/eslint-config-dpuse';

// ── ESLint Configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** @type {import('eslint').Linter.Config[]} */
const config = dpuseESLintConfig({
    files: ['eslint.config.js', 'src/**/*.ts', 'vite.config.ts', 'vitest.config.ts'],
    ignores: ['rust/**'],
    importCoreModules: ['cloudflare:workers'],
    tsconfigPath: './tsconfig.json',
    tsconfigRootDir: import.meta.dirname,
    rules: {}
});

export default config;
