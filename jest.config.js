/** Options shared by both projects (Jest does not inherit them into projects). */
const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps', '<rootDir>/libs'],
  moduleNameMapper: {
    '^@wanderly/config$': '<rootDir>/libs/config/src/index.ts',
    '^@wanderly/db$': '<rootDir>/libs/db/src/index.ts',
    '^@wanderly/recurrence$': '<rootDir>/libs/recurrence/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
};

/** @type {import('jest').Config} */
const config = {
  collectCoverageFrom: ['apps/**/src/**/*.ts', 'libs/**/src/**/*.ts'],
  projects: [
    {
      ...shared,
      displayName: 'unit',
      // Fast, no infrastructure required.
      testMatch: ['**/*.spec.ts'],
    },
    {
      ...shared,
      displayName: 'integration',
      // Real Postgres (see apps/api/test/database.ts for the connection).
      testMatch: ['**/*.int-spec.ts'],
      globalSetup: '<rootDir>/apps/api/test/global-setup.ts',
      setupFiles: ['<rootDir>/apps/api/test/setup-env.ts'],
    },
  ],
};

module.exports = config;
