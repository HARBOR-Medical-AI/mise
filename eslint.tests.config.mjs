// @ts-check
/**
 * @file Jest-only ESLint config for test files across all packages. Enforces
 * that every test contains at least one assertion, so tests that execute code
 * without asserting anything are rejected:
 *
 *   - jest/expect-expect        — every test must contain at least one assertion
 *   - jest/no-standalone-expect — assertions must live inside a test block
 *
 * Kept separate from eslint.config.base.mjs so it can run on its own via
 * `npm run lint:tests` without enabling the wider style rules.
 */
import tseslint from 'typescript-eslint';
import jest from 'eslint-plugin-jest';

export default tseslint.config({
  files: ['packages/*/tests/**/*.{ts,js}', 'packages/*/test/**/*.{ts,js}', 'apps/*/tests/**/*.{ts,js}', 'apps/*/test/**/*.{ts,js}'],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { sourceType: 'module' },
  },
  plugins: { jest },
  rules: {
    'jest/expect-expect': 'error',
    'jest/no-standalone-expect': 'error',
  },
});
