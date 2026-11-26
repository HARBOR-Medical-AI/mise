// @ts-check
/**
 * Architectural seam lint: `@fnndsc/chrisapi` may only be imported by
 * cumin's adapter module (packages/cumin/src/chrisapi/adapter.ts). Every
 * other module — in cumin and downstream packages alike — goes through the
 * adapter's re-exports and generics, keeping the unsafe chrisapi surface
 * auditable in one file.
 *
 * Run with: npm run lint:seam
 */
import tseslint from 'typescript-eslint';

const RESTRICTED_MESSAGE =
  'Import @fnndsc/chrisapi only via packages/cumin/src/chrisapi/adapter.ts (the single seam).';

export default [
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    ignores: ['packages/cumin/src/chrisapi/adapter.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: '@fnndsc/chrisapi', message: RESTRICTED_MESSAGE }],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression > Literal[value="@fnndsc/chrisapi"]',
        message: RESTRICTED_MESSAGE,
      }],
    },
  },
];
