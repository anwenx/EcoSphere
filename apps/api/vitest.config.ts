import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // integration tests share one real database
    testTimeout: 20_000,
  },
});
