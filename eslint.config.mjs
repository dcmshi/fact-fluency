// Flat ESLint config covering all three workspaces. Type-aware linting is
// intentionally left off (the project's strict `tsc --noEmit` already catches
// type errors); this layer is for lint-only correctness rules. Formatting is
// owned by Prettier — `eslint-config-prettier` turns off any stylistic rules
// that would conflict.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'client/src/sw.js', // service-worker globals; not part of the TS build
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript already resolves identifiers, so the core no-undef rule only
    // produces false positives on ambient globals (window, process, …).
    rules: {
      'no-undef': 'off',
      // App output goes through real logging at the edges only; flag stray
      // console use elsewhere (the few intentional bootstrap logs carry an
      // inline disable).
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Developer-facing CLI scripts: the console *is* their user interface, so
    // reporting through it isn't the stray logging the rule is aimed at.
    files: ['scripts/**/*.mjs', 'client/scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['client/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  prettier,
);
