// ESLint 9 flat config for the whole monorepo.
// Type-aware linting is intentionally not enabled here (fast, no project graph);
// `pnpm typecheck` covers type errors.
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/dev-dist/**',
    '**/schema.generated.ts',
    'data/**',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
    },
  },
  // Node code: server, tooling and config files.
  {
    files: ['apps/server/**/*.{ts,js}', '*.{js,mjs,cjs,ts}', '**/*.config.{js,mjs,cjs,ts}'],
    languageOptions: { globals: { ...globals.node } },
  },
  // Isomorphic shared library: only APIs available in Node 22 and modern browsers.
  {
    files: ['packages/shared/**/*.ts'],
    languageOptions: { globals: { ...globals['shared-node-browser'] } },
  },
  {
    files: ['packages/shared/test/**/*.ts', 'packages/shared/**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  // React web app.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['apps/web/e2e/**/*.ts', 'apps/web/**/*.test.{ts,tsx}', 'apps/web/src/test/**'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
)
