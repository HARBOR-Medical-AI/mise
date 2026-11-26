// @ts-check
/**
 * @file ESLint flat config for the TypeScript style guide in this directory.
 *
 * Copy into a project as eslint.config.mjs and adjust `files`. Every rule is an
 * error: the guide asks for a clean lint, so there is no warning tier to burn
 * down. The section names in the comments match STYLE-GUIDE.md.
 *
 * Requires (devDependencies): eslint, typescript, typescript-eslint,
 * eslint-plugin-jsdoc, eslint-plugin-import.
 *
 * @module
 */

import importPlugin from 'eslint-plugin-import';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

/**
 * Prepositions that may not stand where the verb of a method goes
 * (`answerRows_of`, `seriesUID_forPath`). Shared with python/style_check.py.
 */
const PREPOSITIONS = 'of|to|with|from|for|by|as|in|on|at';

/**
 * RPN function name: `<subject>[Qualifier]_<verb>[Adverb]`, both halves
 * lowerCamelCase, exactly one underscore, and a verb (not a preposition) after
 * it. `main` is the one name without a subject. Shared with python/style_check.py.
 */
const RPN_REGEX = `^(?:main|[a-z][a-zA-Z0-9]*_(?!(?:${PREPOSITIONS})(?:[A-Z0-9]|$))[a-z][a-zA-Z0-9]*)$`;

/** Naming: functions RPN, values lowerCamelCase, types PascalCase, constants UPPER_CASE. */
const namingRules = [
  { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
  {
    selector: ['function', 'classMethod', 'objectLiteralMethod', 'typeMethod'],
    format: null,
    leadingUnderscore: 'allow',
    custom: { regex: RPN_REGEX, match: true },
  },
  // A method that overrides a base class keeps the base class's name.
  { selector: 'classMethod', modifiers: ['override'], format: null },
  {
    selector: 'variable',
    types: ['function'],
    format: null,
    custom: { regex: RPN_REGEX, match: true },
  },
  { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  { selector: 'import', format: null },
  // Keys that mirror an external schema keep its spelling: quoted keys
  // ('study_instance_uid') as written, environment variables in UPPER_CASE.
  { selector: 'objectLiteralProperty', format: ['camelCase', 'UPPER_CASE'] },
  { selector: 'objectLiteralProperty', modifiers: ['requiresQuotes'], format: null },
];

/**
 * Sections every file overview names, as python/style_check.py requires of a
 * module docstring. Test files are exempt from the sections, not from @module.
 */
const FILE_OVERVIEW_SECTIONS = ['Key components:', 'Typical usage:', 'Dependencies:'];
const TEST_FILE_PATTERN = /\.(?:test|spec)\.ts$/;

/**
 * Local rule: the `@file` block names the guide's sections and ends with
 * `@module`. jsdoc/require-file-overview reports a file with no such block.
 */
const fileOverviewSectionsRule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require the style guide sections in the @file overview.' },
    schema: [],
    messages: { missing: 'File overview has no {{section}}.' },
  },
  create(context) {
    return {
      Program() {
        const overview = context.sourceCode
          .getAllComments()
          .find((comment) => comment.type === 'Block' && /@file\b/.test(comment.value));
        if (overview === undefined) {
          return;
        }
        const sections = TEST_FILE_PATTERN.test(context.filename) ? [] : FILE_OVERVIEW_SECTIONS;
        for (const section of [...sections, '@module']) {
          if (!overview.value.includes(section)) {
            context.report({ loc: overview.loc, messageId: 'missing', data: { section } });
          }
        }
      },
    };
  },
};

/** Exported declarations, which carry an @example as public Python names do. */
const EXPORTED = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'];
const exampleContexts = EXPORTED.flatMap((exported) => [
  `${exported} > FunctionDeclaration`,
  `${exported} > ClassDeclaration`,
  `${exported} > TSInterfaceDeclaration`,
  `${exported} > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression`,
  `${exported} > ClassDeclaration > ClassBody > ` +
    'MethodDefinition[kind="method"]:not([accessibility="private"]):not([override=true])',
]);

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'eslint.config.mjs'] },
  ...tseslint.configs.strictTypeChecked,
  jsdoc.configs['flat/recommended-typescript-error'],
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { import: importPlugin, local: { rules: { 'file-overview-sections': fileOverviewSectionsRule } } },
    rules: {
      // Naming
      '@typescript-eslint/naming-convention': ['error', ...namingRules],

      // Typing: pervasive and explicit
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // Locals are annotated when the right-hand side does not make the type
      // obvious; that is a judgement, so it is left to review, as in Python.
      '@typescript-eslint/typedef': [
        'error',
        { parameter: true, memberVariableDeclaration: true, propertyDeclaration: true },
      ],

      // Function length: refactor on nesting and complexity, not line count
      'max-depth': ['error', 3],
      complexity: ['error', 15],

      // Imports: node built-ins, third-party, local; ES modules only
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', ['internal', 'parent', 'sibling', 'index']],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'import/first': 'error',
      'import/no-cycle': 'error',
      '@typescript-eslint/no-require-imports': 'error',

      // Documentation. Every file, function, class, method, type and field has
      // a comment, private ones included, as in Python; @param, @returns and
      // @throws on every function; @example on everything exported.
      'jsdoc/require-file-overview': ['error', { tags: { file: { mustExist: true } } }],
      'local/file-overview-sections': 'error',
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: false,
          require: {
            ClassDeclaration: true,
            FunctionDeclaration: true,
            MethodDefinition: true,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            'TSPropertySignature',
            'PropertyDefinition:not([accessibility="private"])',
            'Program > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
          ],
        },
      ],
      // A getter is documented like a field: one line, no @returns, no @example.
      'jsdoc/require-returns': ['error', { checkGetters: false }],
      'jsdoc/require-throws': 'error',
      'jsdoc/require-example': [
        'error',
        { checkConstructors: false, checkGetters: false, checkSetters: false, contexts: exampleContexts },
      ],
      // Blank lines between description, tags and examples, as in the guide's examples.
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],

      // Reliability: no silent failures
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
);
