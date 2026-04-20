import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    alias: {
      // Stub the VS Code extension host API so tests run in plain Node
      vscode: path.resolve(__dirname, 'src/__tests__/__mocks__/vscode.ts'),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/extension.ts', 'src/panelProvider.ts'],
    },
  },
});
