// ESLint for the window code (src/renderer). CI runs only the undefined-name check (build/eslint-undef.json, ESLint 8);
// this config adds ESLint's recommended rules for code-health scans (desloppify) and local use:
//   npm install --no-save @eslint/js@9 globals@15 && npx eslint src/renderer
// Bundled third-party code (src/renderer/vendor) is not checked.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/vendor/**', 'node_modules/**', 'target/**', 'website/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker, __TAURI__: 'readonly' },
    },
    rules: {
      // the CI rule
      'no-undef': 'error',
      // "catch (e) {}" and "_"-prefixed names are deliberate in this code base
      'no-unused-vars': ['warn', { args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
