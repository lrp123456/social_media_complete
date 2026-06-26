module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/../../packages/browser-core/src'],
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
    '^@prisma/client$': '<rootDir>/../../node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/index.js',
  },
};
