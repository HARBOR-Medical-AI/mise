/**
 * Unit tests for argus, with coverage.
 *
 * The panels, the screens and the image engine are tested here against a
 * DOM (jsdom, named per test file) and stand-ins for what needs a graphics
 * card; the smoke suite drives a real browser against a live daemon for
 * the rest. Coverage is collected over the sources, and its floor is held
 * by `scripts/coverage-ratchet.mjs` against `scripts/ratchet-baseline.json`:
 * it may rise, and a fall fails.
 *
 * Left out of the measure, each for a reason that no unit test can answer:
 * - `src/app/main.ts` boots the page when it is imported;
 * - `src/scene/chrisSpace.ts` and `src/features/image/slabScene.ts` draw with WebGL;
 * - `src/scene/layoutWorker.ts` is a worker's entry.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The sources are a root too, so that a file no test reaches is still found and counted, at nothing.
  roots: ['<rootDir>/tests/unit', '<rootDir>/src'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/app/main.ts',
    '!src/scene/chrisSpace.ts',
    '!src/scene/layoutWorker.ts',
    '!src/features/image/slabScene.ts',
  ],
  coverageProvider: 'babel',
  coverageReporters: ['json-summary', 'text-summary'],
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { useESM: true }],
  },
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
