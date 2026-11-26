import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@devvit/web/client` maps `browser` → the real module and everything else
  // to a stub that logs "Can't import client code in the server!".  Vitest
  // resolves through Vite's *server* pipeline, which honours
  // `ssr.resolve.conditions` rather than `resolve.conditions`, so both are set
  // — without them the client module under test is silently the panic stub and
  // the tests would pass while exercising nothing.
  resolve: {
    conditions: ['browser', 'import', 'module', 'default'],
  },
  ssr: {
    resolve: {
      conditions: ['browser', 'import', 'module', 'default'],
      externalConditions: ['browser', 'import', 'module', 'default'],
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'threads',
    reporters: ['default'],
  },
});
