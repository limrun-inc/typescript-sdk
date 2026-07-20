/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Transpile-only: `npm run build` already type-checks the tree; per-file
  // checking inside jest would repeat it on every run.
  transform: { '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true }] },
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^@limrun/api$': '<rootDir>/../../dist/index.js',
    '^@limrun/api/(.*)$': '<rootDir>/../../dist/$1.js',
  },
};
