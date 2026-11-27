// @ts-check
/**
 * @file Jest-only ESLint config for test files across all packages. Enforces
 * that every test contains at least one assertion, so tests that execute code
 * without asserting anything are rejected:
 *
 *   - jest/expect-expect        — every test must contain at least one assertion
 *   - jest/no-standalone-expect — assertions must live inside a test block
 *
 * Kept separate from eslint.config.mjs (the style guide's rules, held by
 * `npm run lint`) so it runs on its own via `npm run lint:tests`, at zero.
 */
import tseslint from 'typescript-eslint';
import jest from 'eslint-plugin-jest';

export default tseslint.config({
  // The same two patterns as the `lint:tests` command in package.json: what the command hands over and what
  // this config takes are one list (scripts/ratchets.test.mjs holds them to it).
  files: ['packages/*/{test,tests}/**/*.{ts,js}', 'apps/*/{test,tests}/**/*.{ts,js}'],
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
