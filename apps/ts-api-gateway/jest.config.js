module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      isolatedModules: true,
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@social-media/browser-core$': '<rootDir>/../../packages/browser-core/src',
    '^@social-media/shared-config$': '<rootDir>/../../packages/shared-config/src',
    '^@social-media/selectors$': '<rootDir>/../../packages/selectors/src',
  },
};
