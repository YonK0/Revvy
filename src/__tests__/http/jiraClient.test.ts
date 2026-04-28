// src/__tests__/http/jiraClient.test.ts
// Unit tests for JiraClient — ticket fetching with v2/v3 description handling.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { JiraClient } from '../../http/jiraClient';
import { BaseHttpClient } from '../../http/baseClient';
import type { Credentials } from '../../http/credentials';

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeCredentials(auth: { user: string; token: string } = { user: 'alice', token: 'tok' }): Credentials {
  return {
    getToken:           vi.fn(),
    setToken:           vi.fn(),
    getBasicAuth:       vi.fn().mockResolvedValue(auth),
    setBasicAuth:       vi.fn(),
    clear:              vi.fn(),
    promptForToken:     vi.fn(),
    promptForBasicAuth: vi.fn().mockResolvedValue(auth),
  } as unknown as Credentials;
}

function makeNoCredentials(): Credentials {
  return {
    getToken:           vi.fn(),
    setToken:           vi.fn(),
    getBasicAuth:       vi.fn().mockResolvedValue(undefined),
    setBasicAuth:       vi.fn(),
    clear:              vi.fn(),
    promptForToken:     vi.fn(),
    promptForBasicAuth: vi.fn().mockResolvedValue(undefined),
  } as unknown as Credentials;
}

function mockConfig(baseUrl: string, apiVersion = '2') {
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section?: string) => ({
    get: (key: string, defaultValue: any) => {
      if (section === 'revvy.jira') {
        if (key === 'baseUrl')    { return baseUrl; }
        if (key === 'apiVersion') { return apiVersion; }
      }
      if (section === 'revvy.network') { return defaultValue; }
      return defaultValue;
    },
  } as any));
}

// ── Jira v2 issue payload helper ─────────────────────────────────────────────

function v2Payload(description: string) {
  return {
    key: 'PROJ-42',
    fields: {
      summary:     'Implement login',
      status:      { name: 'In Progress' },
      description,
    },
  };
}

// ── Jira v3 ADF payload helper ───────────────────────────────────────────────

function v3Payload() {
  return {
    key: 'PROJ-7',
    fields: {
      summary: 'Fix crash',
      status:  { name: 'Open' },
      description: {
        type:    'doc',
        version: 1,
        content: [
          {
            type:    'paragraph',
            content: [
              { type: 'text', text: 'This is ' },
              { type: 'text', text: 'the description.' },
            ],
          },
        ],
      },
    },
  };
}

// ── Tests: fetchTicket ────────────────────────────────────────────────────────

describe('JiraClient.fetchTicket — v2 plain-text description', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('parses key, summary, status, and description', async () => {
    mockConfig('https://jira.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(v2Payload('Must use bcrypt.')), headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const ticket = await client.fetchTicket('PROJ-42');
    expect(ticket.key).toBe('PROJ-42');
    expect(ticket.summary).toBe('Implement login');
    expect(ticket.status).toBe('In Progress');
    expect(ticket.description).toBe('Must use bcrypt.');
  });

  it('normalises CRLF line endings in description', async () => {
    mockConfig('https://jira.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(v2Payload('line1\r\nline2\r\nline3')), headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const ticket = await client.fetchTicket('PROJ-42');
    expect(ticket.description).toBe('line1\nline2\nline3');
  });

  it('returns empty string for null description', async () => {
    mockConfig('https://jira.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ key: 'X-1', fields: { summary: 'S', status: { name: 'Done' }, description: null } }),
      headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const ticket = await client.fetchTicket('X-1');
    expect(ticket.description).toBe('');
  });
});

describe('JiraClient.fetchTicket — v3 ADF description', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('flattens an ADF document to plain text', async () => {
    mockConfig('https://jira.example.com', '3');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(v3Payload()), headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const ticket = await client.fetchTicket('PROJ-7');
    expect(ticket.key).toBe('PROJ-7');
    expect(ticket.description).toContain('This is ');
    expect(ticket.description).toContain('the description.');
  });

  it('appends a newline separator after paragraphs', async () => {
    mockConfig('https://jira.example.com', '3');
    const payload = {
      key: 'X-2',
      fields: {
        summary: 'S', status: { name: 'Done' },
        description: {
          type: 'doc', version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Para one.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Para two.' }] },
          ],
        },
      },
    };
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200, body: JSON.stringify(payload), headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const ticket = await client.fetchTicket('X-2');
    expect(ticket.description).toContain('\n');
    expect(ticket.description).toContain('Para one.');
    expect(ticket.description).toContain('Para two.');
  });
});

describe('JiraClient.fetchTicket — error handling', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('throws on 401 with a hint about credentials', async () => {
    mockConfig('https://jira.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 401, body: 'Unauthorized', headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const err    = await client.fetchTicket('PROJ-1').catch(e => e);
    expect(err.message).toContain('401');
    expect(err.message).toContain('username or token');
  });

  it('throws on 404 with hint about ticket key', async () => {
    mockConfig('https://jira.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 404, body: 'Issue Does Not Exist', headers: {},
    });

    const client = new JiraClient(makeCredentials());
    const err    = await client.fetchTicket('FAKE-999').catch(e => e);
    expect(err.message).toContain('404');
    expect(err.message).toContain('FAKE-999');
  });

  it('throws when baseUrl is not configured', async () => {
    mockConfig('');
    const client = new JiraClient(makeCredentials());
    await expect(client.fetchTicket('PROJ-1'))
      .rejects.toThrow('revvy.jira.baseUrl is not configured');
  });

  it('throws when credentials are unavailable', async () => {
    mockConfig('https://jira.example.com');
    const client = new JiraClient(makeNoCredentials());
    await expect(client.fetchTicket('PROJ-1'))
      .rejects.toThrow('Jira credentials are required');
  });

  it('uses Basic auth header with base64-encoded user:token', async () => {
    mockConfig('https://jira.example.com');
    vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ key: 'P-1', fields: { summary: 'S', status: { name: 'Open' }, description: '' } }),
      headers: {},
    });

    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request');
    const client     = new JiraClient(makeCredentials({ user: 'alice', token: 'secret' }));
    await client.fetchTicket('P-1');

    const opts: any = requestSpy.mock.calls[0][1];
    const expected  = `Basic ${Buffer.from('alice:secret').toString('base64')}`;
    expect(opts.headers['Authorization']).toBe(expected);
  });

  it('prepends https:// when baseUrl has no scheme', async () => {
    mockConfig('jira.example.com'); // no https://
    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ key: 'P-1', fields: { summary: 'S', status: { name: 'Open' }, description: '' } }),
      headers: {},
    });

    const client = new JiraClient(makeCredentials());
    await client.fetchTicket('P-1');

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^https:\/\/jira\.example\.com/);
  });

  it('preserves an explicit http:// scheme', async () => {
    mockConfig('http://jira.internal.corp');
    const requestSpy = vi.spyOn(BaseHttpClient.prototype as any, 'request').mockResolvedValue({
      status: 200,
      body: JSON.stringify({ key: 'P-2', fields: { summary: 'T', status: { name: 'Open' }, description: '' } }),
      headers: {},
    });

    const client = new JiraClient(makeCredentials());
    await client.fetchTicket('P-2');

    const calledUrl: string = requestSpy.mock.calls[0][0];
    expect(calledUrl).toMatch(/^http:\/\/jira\.internal\.corp/);
  });
});
