// src/__tests__/http/githubClient.test.ts
// Unit tests for GitHubClient — PR metadata and raw diff.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { GitHubClient } from '../../http/githubClient';
import { BaseHttpClient } from '../../http/baseClient';
import type { Credentials } from '../../http/credentials';

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeCredentials(token: string = 'ghp-test'): Credentials {
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

function mockConfig(baseUrl = 'https://api.github.com') {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section?: string) => ({
    get: (key: string, defaultValue: any) => {
      if (section === 'revvy.github' && key === 'baseUrl') { return baseUrl; }
      if (section === 'revvy.network') { return defaultValue; }
      return defaultValue;
    },
  } as any));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GitHubClient.fetchPR', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('fetches and parses PR metadata', async () => {
    mockConfig();
    const pr = {
      number: 17, title: 'Add feature', body: 'details',
      head: { ref: 'feat/x' }, base: { ref: 'main' },
      html_url: 'https://github.com/org/repo/pull/17', changed_files: 3,
    };
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(pr), headers: {},
    });

    const client = new GitHubClient(makeCredentials());
    const result = await client.fetchPR('org', 'repo', 17);
    expect(result.number).toBe(17);
    expect(result.title).toBe('Add feature');
    expect(result.changed_files).toBe(3);
  });

  it('throws on 401', async () => {
    mockConfig();
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 401, body: 'Bad credentials', headers: {},
    });

    const client = new GitHubClient(makeCredentials());
    await expect(client.fetchPR('org', 'repo', 1)).rejects.toThrow('401');
  });

  it('throws on 404 with a hint', async () => {
    mockConfig();
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 404, body: 'Not Found', headers: {},
    });

    const client = new GitHubClient(makeCredentials());
    const err    = await client.fetchPR('org', 'repo', 999).catch(e => e);
    expect(err.message).toContain('404');
    expect(err.message).toContain('not found');
  });

  it('throws when no token is available', async () => {
    mockConfig();
    const client = new GitHubClient(makeNoTokenCredentials());
    await expect(client.fetchPR('org', 'repo', 1))
      .rejects.toThrow('GitHub token is required');
  });

  it('prepends https:// when baseUrl has no scheme', async () => {
    mockConfig('api.github.example.com'); // no https://
    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ number: 1, title: 'T', body: '', head: { ref: 'x' }, base: { ref: 'main' }, html_url: '', changed_files: 0 }),
      headers: {},
    });

    const client = new GitHubClient(makeCredentials());
    await client.fetchPR('org', 'repo', 1);

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^https:\/\/api\.github\.example\.com/);
  });

  it('preserves an explicit http:// scheme', async () => {
    mockConfig('http://github.internal.corp');
    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ number: 2, title: 'U', body: '', head: { ref: 'y' }, base: { ref: 'main' }, html_url: '', changed_files: 0 }),
      headers: {},
    });

    const client = new GitHubClient(makeCredentials());
    await client.fetchPR('org', 'repo', 2);

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^http:\/\/github\.internal\.corp/);
  });

  it('uses the configured Enterprise base URL', async () => {
    mockConfig('https://github.example.com/api/v3');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ number: 5, title: 'T', body: '', head: { ref: 'x' }, base: { ref: 'main' }, html_url: '', changed_files: 0 }),
      headers: {},
    });

    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request');
    const client     = new GitHubClient(makeCredentials());
    await client.fetchPR('org', 'repo', 5);

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toContain('github.example.com');
  });
});

describe('GitHubClient.fetchDiff', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns the raw unified diff string', async () => {
    mockConfig();
    const rawDiff = `diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n`;
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: rawDiff, headers: { 'content-type': 'text/x-patch' },
    });

    const client = new GitHubClient(makeCredentials());
    const diff   = await client.fetchDiff('org', 'repo', 17);
    expect(diff).toBe(rawDiff);
  });

  it('requests the diff Accept header', async () => {
    mockConfig();
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: 'diff text', headers: {},
    });

    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request');
    const client     = new GitHubClient(makeCredentials());
    await client.fetchDiff('org', 'repo', 3);

    const opts: any = requestSpy.mock.calls[0][1];
    expect(opts.headers['Accept']).toBe('application/vnd.github.v3.diff');
  });
});
