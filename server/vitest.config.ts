import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Jobs render in headless Chrome (self-check, delivery check); several run inside one test.
    testTimeout: 30_000,
  },
});
