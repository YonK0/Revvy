// src/__tests__/http/credentials.test.ts
// Unit tests for Credentials — SecretStorage wrapper.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Credentials } from '../../http/credentials';

// ── Mock VS Code ExtensionContext ────────────────────────────────────────────

function makeContext(store: Record<string, string> = {}) {
  return {
    secrets: {
      get:    vi.fn(async (key: string) => store[key]),
      store:  vi.fn(async (key: string, value: string) => { store[key] = value; }),
      delete: vi.fn(async (key: string) => { delete store[key]; }),
    },
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Credentials.getToken / setToken', () => {
  it('returns undefined when no token is stored', async () => {
    const creds = new Credentials(makeContext());
    expect(await creds.getToken('gitlab')).toBeUndefined();
  });

  it('stores and retrieves a token', async () => {
    const store: Record<string, string> = {};
    const creds = new Credentials(makeContext(store));
    await creds.setToken('gitlab', 'glpat-test-token');
    expect(store['revvy.gitlab.token']).toBe('glpat-test-token');
    expect(await creds.getToken('gitlab')).toBe('glpat-test-token');
  });

  it('namespaces tokens per service', async () => {
    const store: Record<string, string> = {};
    const creds = new Credentials(makeContext(store));
    await creds.setToken('github', 'ghp-github');
    await creds.setToken('gitlab', 'glpat-gitlab');
    expect(store['revvy.github.token']).toBe('ghp-github');
    expect(store['revvy.gitlab.token']).toBe('glpat-gitlab');
    expect(await creds.getToken('github')).toBe('ghp-github');
    expect(await creds.getToken('gitlab')).toBe('glpat-gitlab');
  });
});

describe('Credentials.getBasicAuth / setBasicAuth', () => {
  it('returns undefined when neither user nor token is stored', async () => {
    const creds = new Credentials(makeContext());
    expect(await creds.getBasicAuth('jira')).toBeUndefined();
  });

  it('returns undefined when only token is stored (missing user)', async () => {
    const store = { 'revvy.jira.token': 'tok' };
    const creds = new Credentials(makeContext(store));
    expect(await creds.getBasicAuth('jira')).toBeUndefined();
  });

  it('stores and retrieves basic auth credentials', async () => {
    const store: Record<string, string> = {};
    const creds = new Credentials(makeContext(store));
    await creds.setBasicAuth('jira', 'alice', 'secret');
    expect(store['revvy.jira.user']).toBe('alice');
    expect(store['revvy.jira.token']).toBe('secret');
    expect(await creds.getBasicAuth('jira')).toEqual({ user: 'alice', token: 'secret' });
  });
});

describe('Credentials.clear', () => {
  it('removes both token and user keys', async () => {
    const store: Record<string, string> = {
      'revvy.gitlab.token': 'tok',
      'revvy.gitlab.user':  'bob',
    };
    const ctx   = makeContext(store);
    const creds = new Credentials(ctx);
    await creds.clear('gitlab');
    expect(ctx.secrets.delete).toHaveBeenCalledWith('revvy.gitlab.token');
    expect(ctx.secrets.delete).toHaveBeenCalledWith('revvy.gitlab.user');
  });
});

describe('Credentials.promptForToken', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('stores and returns the token when user confirms', async () => {
    const { window } = await import('vscode');
    vi.spyOn(window, 'showInputBox').mockResolvedValue('entered-token' as any);

    const store: Record<string, string> = {};
    const creds = new Credentials(makeContext(store));
    const result = await creds.promptForToken('github');

    expect(result).toBe('entered-token');
    expect(store['revvy.github.token']).toBe('entered-token');
  });

  it('returns undefined when user cancels', async () => {
    const { window } = await import('vscode');
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined as any);

    const creds = new Credentials(makeContext());
    const result = await creds.promptForToken('github');
    expect(result).toBeUndefined();
  });
});

describe('Credentials.promptForBasicAuth', () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it('returns undefined when user cancels username prompt', async () => {
    const { window } = await import('vscode');
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined as any);
    const creds  = new Credentials(makeContext());
    expect(await creds.promptForBasicAuth('jira')).toBeUndefined();
  });

  it('returns undefined when user cancels password prompt', async () => {
    const { window } = await import('vscode');
    vi.spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('alice' as any)
      .mockResolvedValueOnce(undefined as any);
    const creds = new Credentials(makeContext());
    expect(await creds.promptForBasicAuth('jira')).toBeUndefined();
  });

  it('stores and returns credentials when both prompts complete', async () => {
    const { window } = await import('vscode');
    vi.spyOn(window, 'showInputBox')
      .mockResolvedValueOnce('alice' as any)
      .mockResolvedValueOnce('password123' as any);
    const store: Record<string, string> = {};
    const creds  = new Credentials(makeContext(store));
    const result = await creds.promptForBasicAuth('jira');
    expect(result).toEqual({ user: 'alice', token: 'password123' });
    expect(store['revvy.jira.user']).toBe('alice');
    expect(store['revvy.jira.token']).toBe('password123');
  });
});
