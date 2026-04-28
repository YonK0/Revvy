// src/__tests__/http/baseClient.test.ts
// Unit tests for BaseHttpClient — proxy bypass and error formatting.
// Network I/O is mocked; no real HTTP calls are made.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { BaseHttpClient } from '../../http/baseClient';

// ── Concrete test subclass to expose protected methods ───────────────────────

class TestClient extends BaseHttpClient {
  public exposedShouldBypassProxy(url: string) {
    return this.shouldBypassProxy(url);
  }
  public exposedGetNoProxyHosts() {
    return this.getNoProxyHosts();
  }
  public exposedFormatError(service: string, url: string, status: number, body: string, hint?: string) {
    return this.formatError(service, url, status, body, hint);
  }
  public exposedRequest(url: string, opts = {}) {
    return this.request(url, opts);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfigWithNoProxy(hosts: string[]) {
  return vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (_key: string, defaultValue: any) =>
      _key === 'noProxy' ? hosts : defaultValue,
  } as any);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BaseHttpClient.shouldBypassProxy', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns false when noProxy list is empty', () => {
    makeConfigWithNoProxy([]);
    const client = new TestClient();
    expect(client.exposedShouldBypassProxy('https://gitlab.example.com/api')).toBe(false);
  });

  it('returns true for an exact hostname match', () => {
    makeConfigWithNoProxy(['gitlab.example.com']);
    const client = new TestClient();
    expect(client.exposedShouldBypassProxy('https://gitlab.example.com/api/v4')).toBe(true);
  });

  it('returns true for a subdomain of a noProxy entry', () => {
    makeConfigWithNoProxy(['example.com']);
    const client = new TestClient();
    expect(client.exposedShouldBypassProxy('https://jira.example.com/rest')).toBe(true);
  });

  it('returns false for an unrelated hostname', () => {
    makeConfigWithNoProxy(['example.com']);
    const client = new TestClient();
    expect(client.exposedShouldBypassProxy('https://other.corp.com/path')).toBe(false);
  });

  it('returns false for a malformed URL without throwing', () => {
    makeConfigWithNoProxy(['example.com']);
    const client = new TestClient();
    expect(client.exposedShouldBypassProxy('not-a-url')).toBe(false);
  });
});

describe('BaseHttpClient.formatError', () => {
  it('includes service, status, and URL in the message', () => {
    const client = new TestClient();
    const err    = client.exposedFormatError('GitLab', 'https://gl.example.com/api', 401, 'Unauthorized');
    expect(err.message).toContain('GitLab');
    expect(err.message).toContain('401');
    expect(err.message).toContain('https://gl.example.com/api');
    expect(err.message).toContain('Unauthorized');
  });

  it('includes the hint when provided', () => {
    const client = new TestClient();
    const err    = client.exposedFormatError('Jira', 'https://jira.co/rest', 401, 'Unauth', 'wrong credentials');
    expect(err.message).toContain('wrong credentials');
  });

  it('truncates very long response bodies to 500 chars', () => {
    const client  = new TestClient();
    const longBody = 'x'.repeat(2000);
    const err     = client.exposedFormatError('GitHub', 'https://api.github.com', 500, longBody);
    // The error message itself should not embed the full 2000-char body
    const bodySection = err.message.split('Response:')[1] ?? '';
    expect(bodySection.length).toBeLessThanOrEqual(510); // 500 + some whitespace/newline
  });
});

// Note: BaseHttpClient.request() is tested indirectly through the higher-level
// GitLabClient, GitHubClient, and JiraClient tests which mock the method at the
// prototype level.  Direct mocking of Node's built-in https.request is skipped
// here because the property is non-configurable and cannot be spied on via vitest.
