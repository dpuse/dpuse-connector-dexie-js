// ── External Dependencies & Registrations
import { dpuseESLintConfig } from '@dpuse/eslint-config-dpuse';

// ── ESLint Configuration ─────────────────────────────────────────────────────────────────────────────────────────────

/** @type {import('eslint').Linter.Config[]} */
const config = dpuseESLintConfig({
    ignores: ['rust/**'],
    rules: {}
});

export default config;
