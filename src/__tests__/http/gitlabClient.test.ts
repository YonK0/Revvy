// src/__tests__/http/gitlabClient.test.ts
// Unit tests for GitLabClient — MR metadata and paginated diffs.
// No real network calls; request() is mocked on the prototype.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { GitLabClient } from '../../http/gitlabClient';
import { BaseHttpClient } from '../../http/baseClient';
import type { Credentials } from '../../http/credentials';

// ── Mock credentials ─────────────────────────────────────────────────────────

function makeCredentials(token: string = 'glpat-test'): Credentials {
  return {
    getToken:           vi.fn().mockResolvedValue(token),
    setToken:           vi.fn(),
    getBasicAuth:       vi.fn(),
    setBasicAuth:       vi.fn(),
    clear:              vi.fn(),
    promptForToken:     vi.fn().mockResolvedValue(token),
    promptForBasicAuth: vi.fn(),
  } as unknown as Credentials;
}

function makeNoTokenCredentials(): Credentials {
  return {
    getToken:           vi.fn().mockResolvedValue(undefined),
    setToken:           vi.fn(),
    getBasicAuth:       vi.fn(),
    setBasicAuth:       vi.fn(),
    clear:              vi.fn(),
    promptForToken:     vi.fn().mockResolvedValue(undefined),
    promptForBasicAuth: vi.fn(),
  } as unknown as Credentials;
}

// ── Config mock helper ────────────────────────────────────────────────────────

function mockConfig(baseUrl: string, apiVersion = 'v4') {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section?: string) => ({
    get: (key: string, defaultValue: any) => {
      if (section === 'revvy.gitlab') {
        if (key === 'baseUrl')    { return baseUrl; }
        if (key === 'apiVersion') { return apiVersion; }
      }
      if (section === 'revvy.network') { return defaultValue; }
      return defaultValue;
    },
  } as any));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GitLabClient.fetchMR', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches MR metadata and parses JSON', async () => {
    mockConfig('https://gitlab.example.com');
    const mrPayload = { iid: 42, title: 'Fix bug', description: 'details', web_url: 'https://...' };
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(mrPayload), headers: {},
    });

    const client = new GitLabClient(makeCredentials());
    const mr     = await client.fetchMR('group/project', 42);
    expect(mr.iid).toBe(42);
    expect(mr.title).toBe('Fix bug');
  });

  it('throws with a descriptive hint on 401', async () => {
    mockConfig('https://gitlab.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 401, body: 'Unauthorized', headers: {},
    });

    const client = new GitLabClient(makeCredentials());
    await expect(client.fetchMR('group/project', 1)).rejects.toThrow('401');
  });

  it('throws when baseUrl is not configured', async () => {
    mockConfig(''); // empty baseUrl
    const client = new GitLabClient(makeCredentials());
    await expect(client.fetchMR('group/project', 1))
      .rejects.toThrow('revvy.gitlab.baseUrl is not configured');
  });

  it('throws when no token is available', async () => {
    mockConfig('https://gitlab.example.com');
    const client = new GitLabClient(makeNoTokenCredentials());
    await expect(client.fetchMR('group/project', 1))
      .rejects.toThrow('GitLab token is required');
  });

  it('prepends https:// when baseUrl has no scheme', async () => {
    mockConfig('gitlab.example.com'); // no https://
    const mrPayload = { iid: 1, title: 'T', description: '', web_url: '' };
    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(mrPayload), headers: {},
    });

    const client = new GitLabClient(makeCredentials());
    await client.fetchMR('group/project', 1);

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^https:\/\/gitlab\.example\.com/);
  });

  it('preserves an explicit http:// scheme', async () => {
    mockConfig('http://gitlab.internal.corp');
    const mrPayload = { iid: 2, title: 'U', description: '', web_url: '' };
    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(mrPayload), headers: {},
    });

    const client = new GitLabClient(makeCredentials());
    await client.fetchMR('group/project', 2);

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^http:\/\/gitlab\.internal\.corp/);
  });
});

describe('GitLabClient.fetchDiffs', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns all diff files on a single-page response', async () => {
    mockConfig('https://gitlab.example.com');
    const diffs = [
      { diff: '@@ -1 +1 @@\n-old\n+new\n', new_path: 'src/a.ts', old_path: 'src/a.ts', new_file: false, renamed_file: false, deleted_file: false },
    ];
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(diffs), headers: {},
    });

    const client = new GitLabClient(makeCredentials());
    const result = await client.fetchDiffs('group/project', 7);
    expect(result).toHaveLength(1);
    expect(result[0].new_path).toBe('src/a.ts');
  });

  it('handles paginated responses correctly', async () => {
    mockConfig('https://gitlab.example.com');

    // First page returns 100 items (full page), second returns 3 (partial = last)
    const fullPage  = Array.from({ length: 100 }, (_, i) => ({
      diff: '', new_path: `src/file${i}.ts`, old_path: `src/file${i}.ts`,
      new_file: false, renamed_file: false, deleted_file: false,
    }));
    const partPage  = [
      { diff: '', new_path: 'src/extra.ts', old_path: 'src/extra.ts', new_file: false, renamed_file: false, deleted_file: false },
    ];

    vi.spyOn(BaseHttpClient.prototype as any, 'request')
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(fullPage), headers: {} })
      .mockResolvedValueOnce({ status: 200, body: JSON.stringify(partPage), headers: {} });

    const client = new GitLabClient(makeCredentials());
    const result = await client.fetchDiffs('group/project', 99);
    expect(result).toHaveLength(101);
  });

  it('stops after 10 pages (safety cap)', async () => {
    mockConfig('https://gitlab.example.com');
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      diff: '', new_path: `file${i}.ts`, old_path: `file${i}.ts`,
      new_file: false, renamed_file: false, deleted_file: false,
    }));
    // Always returns a full page — would loop forever without the cap
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(fullPage), headers: {},
    });

    const client = new GitLabClient(makeCredentials());
    const result = await client.fetchDiffs('group/project', 1);
    expect(result).toHaveLength(1000); // 10 pages × 100
  });

  it('URL-encodes the project path', async () => {
    mockConfig('https://gitlab.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: '[]', headers: {},
    });

    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request');
    const client     = new GitLabClient(makeCredentials());
    await client.fetchDiffs('group/sub/project', 5);

    const calledUrl: string = requestSpy.mock.calls[0][0];
    // The project path should be URL-encoded (slashes become %2F)
    expect(calledUrl).toContain('group%2Fsub%2Fproject');
  });
});
