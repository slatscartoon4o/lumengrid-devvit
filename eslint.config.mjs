// ESLint flat config.
//
// This file did not exist: `npm run lint` has been in package.json since the
// first commit and has never run, because ESLint 9+ needs an eslint.config.*
// and found none.  Four packages were installed for it and never used.  The
// addendum is here because the two defect classes this project actually shipped
// — a function defined but never called, and one format reimplemented three
// ways — are both things a linter is better at noticing than a reviewer.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-local/**', 'node_modules/**', 'coverage/**', 'docs/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // The bug that shipped twice: a symbol with exactly one occurrence is
      // almost always a definition nobody reached.  `_`-prefixed names are the
      // documented escape hatch for genuinely unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    files: ['src/client/**/*.tsx'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Worker-ish and server code runs in node; the client runs in a browser.
  {
    files: ['src/server/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  // The local preview server prints its URL on boot — that is its job, not a
  // stray debug line.
  {
    files: ['src/server/local-server.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Shared code runs in all three environments, so it may use neither
  // environment's globals — only the language itself.
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: { globals: {} },
  }
);
