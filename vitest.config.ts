import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  esbuild: { jsx: 'automatic' },
  // The existing suite covers the classic flow; Moves tests switch HIPPO_MOVES on themselves (Preview defaults it on).
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'src/**/__tests__/**/*.test.ts'], environment: 'node', env: { HIPPO_MOVES: 'off' } },
});
