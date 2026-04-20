// src/__tests__/__mocks__/vscode.ts
// Minimal stub of the VS Code API surface used by the modules under test.
// Only the symbols actually imported by ruleLoader.ts need to be present.

export const workspace = {
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export class RelativePattern {
  constructor(public base: string, public pattern: string) {}
}

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
};
