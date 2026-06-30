// ── External Dependencies & Registrations
import type { Linter } from 'eslint';
import pluginComments from '@eslint-community/eslint-plugin-eslint-comments';
import { flatConfigs as pluginImportFlatConfigs } from 'eslint-plugin-import-x';
import { configs as pluginRegexpConfigs } from 'eslint-plugin-regexp';
import pluginSecurity from 'eslint-plugin-security';
import pluginSonarJS from 'eslint-plugin-sonarjs';
import pluginUnicorn from 'eslint-plugin-unicorn';
import skipFormatting from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

// ── ESLint Configuration ─────────────────────────────────────────────────────────────────────────────────────────────

export default defineConfig(
    // Linting scope, strict TypeScript type-checking, and module resolver.
    {
        files: ['eslint.config.ts', 'src/**/*.ts', 'vite.config.ts', 'vitest.config.ts'],
        extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
        languageOptions: {
            parserOptions: { project: './tsconfig.json' }
        },
        settings: {
            'import-x/core-modules': ['cloudflare:workers'],
            'import-x/resolver': {
                typescript: { project: ['./tsconfig.json'] }
            }
        }
    },

    // Ignores.
    globalIgnores(['bundle-analysis-reports/**', 'dependency-check-bin/**', 'dependency-check-reports/**', 'dist/**', 'licenses/**', 'rust/**/pkg/**']),

    // Plugin configurations.
    {
        // '@eslint-community/eslint-comments' only ships a legacy config; manually convert to flat format.
        plugins: { '@eslint-community/eslint-comments': pluginComments },
        rules: {
            '@eslint-community/eslint-comments/disable-enable-pair': 'error',
            '@eslint-community/eslint-comments/no-aggregating-enable': 'error',
            '@eslint-community/eslint-comments/no-duplicate-disable': 'error',
            '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
            '@eslint-community/eslint-comments/no-unused-enable': 'error'
        }
    },
    pluginImportFlatConfigs.recommended,
    pluginRegexpConfigs['flat/recommended'],
    pluginSecurity.configs.recommended,
    (pluginSonarJS.configs?.['recommended'] ?? {}) as Linter.Config,
    pluginUnicorn.configs.recommended,
    skipFormatting,

    // Rule overrides.
    {
        rules: {
            'sort-imports': ['warn', { allowSeparatedGroups: true, ignoreCase: true, memberSyntaxSortOrder: ['none', 'all', 'single', 'multiple'] }],

            '@typescript-eslint/no-unused-vars': 'warn',

            '@eslint-community/eslint-comments/require-description': 'warn',

            'security/detect-object-injection': 'off',

            'sonarjs/no-commented-code': 'warn',
            'sonarjs/no-dead-store': 'warn',
            'sonarjs/no-unused-vars': 'warn',
            'sonarjs/todo-tag': 'warn',

            'unicorn/no-null': 'off',
            'unicorn/switch-case-braces': ['warn', 'avoid']
        }
    }
);
