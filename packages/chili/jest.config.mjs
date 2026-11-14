export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/?(*.)+(spec|test).[jt]s?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: { module: 'CommonJS' } }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^chalk$': '<rootDir>/__mocks__/chalk.js',
  },
  // Excluded from coverage: barrels (re-exports) and the CLI entry point.
  // screen.ts is kept — its table formatting is assertable.
  collectCoverageFrom: [
    '<rootDir>/src/**/*.ts',
    '!<rootDir>/src/index.ts',
    '!<rootDir>/src/**/*.d.ts',
    '!<rootDir>/src/run.ts', // commander bootstrap entry
    '!<rootDir>/src/utils.ts', // barrel
    '!<rootDir>/src/models/listing.ts', // barrel
  ],
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  coverageProvider: 'babel',
  // Minimum coverage enforced by CI; raise as coverage improves.
  coverageThreshold: {
    // Ratcheted 2026-08 after the screen.ts lift (65% -> 93%): thresholds sit
    // just under the measured 90.6/76.8/92.4/91.0 so the gain cannot erode.
    // Branches 77 since the path mapper, well covered, moved to salsa (77.8).
    global: { statements: 91, branches: 77, functions: 93, lines: 92 },
    // Per-file floor: no covered file may fall below 60% statements/lines.
    './src/**/*.ts': { statements: 60, lines: 60 },
  },
};
