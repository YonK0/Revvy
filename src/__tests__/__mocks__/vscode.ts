// src/__tests__/__mocks__/vscode.ts
// Minimal stub of the VS Code API surface used by the modules under test.
// Covers: ruleLoader.ts, reviewer.ts, aiBackend.ts, and the new http/* clients.

export const workspace = {
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  /**
   * Minimal getConfiguration stub.
   * Returns a config object whose get() always returns the provided default.
   * Individual tests can override this via vi.spyOn(vscode.workspace, 'getConfiguration').
   */
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue,
  }),
};

export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage:     () => Promise.resolve(undefined),
  showErrorMessage:       () => Promise.resolve(undefined),
  showInputBox:           () => Promise.resolve(undefined),
};
