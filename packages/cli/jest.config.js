/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  moduleNameMapper: {
    '^@limrun/api$': '<rootDir>/../../dist/index.js',
    '^@limrun/api/(.*)$': '<rootDir>/../../dist/$1.js',
  },
};
