// src/__tests__/http/baseClient.test.ts
// Unit tests for BaseHttpClient — proxy bypass, tls.connect path, and error formatting.
// Network I/O is mocked; no real HTTP calls are made.
//
// Note: tls.connect is a non-configurable Node built-in — vi.spyOn() cannot replace it.
// We use vi.mock('tls', factory) instead, which vitest hoists before any imports and
// intercepts the module resolver, bypassing the configurable restriction.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';

// ── Mock tls.connect before any module that imports it ───────────────────────
// vitest hoists vi.mock() calls to the top of the file automatically.

vi.mock('tls', () => ({
  connect: vi.fn(),
}));

import * as tls from 'tls';
import { BaseHttpClient, parseRawHttpResponse, decodeChunked } from '../../http/baseClient';

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

// ── Config mock helpers ───────────────────────────────────────────────────────

function makeConfigWithNoProxy(hosts: string[], allowInsecureTls = false) {
  return vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
    get: (_key: string, defaultValue: any) => {
      if (_key === 'noProxy')           { return hosts; }
      if (_key === 'allowInsecureTls')  { return allowInsecureTls; }
      return defaultValue;
    },
  } as any);
}

// ── Fake socket factory ───────────────────────────────────────────────────────
// Behaves like a tls.TLSSocket: has setTimeout, write, destroy, and is an EventEmitter.

function makeFakeSocket() {
  const emitter = new EventEmitter() as any;
  emitter.setTimeout = vi.fn();
  emitter.write      = vi.fn();
  emitter.destroy    = vi.fn((err?: Error) => { if (err) { emitter.emit('error', err); } });
  return emitter;
}

// ── Raw HTTP response builders ────────────────────────────────────────────────

function buildHttpResponse(
  status:   number,
  body:     string,
  extraHeaders: Record<string, string> = {},
): Buffer {
  const statusText = status === 200 ? 'OK' : status === 401 ? 'Unauthorized' : 'Error';
  let headerText = `HTTP/1.1 ${status} ${statusText}\r\n`;
  for (const [k, v] of Object.entries(extraHeaders)) {
    headerText += `${k}: ${v}\r\n`;
  }
  headerText += `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n`;
  headerText += '\r\n';
  return Buffer.concat([Buffer.from(headerText, 'ascii'), Buffer.from(body, 'utf8')]);
}

function buildChunkedResponse(status: number, bodyChunks: string[]): Buffer {
  let headerText = `HTTP/1.1 ${status} OK\r\nTransfer-Encoding: chunked\r\n\r\n`;
  let bodyText = '';
  for (const chunk of bodyChunks) {
    const size = Buffer.byteLength(chunk, 'utf8').toString(16);
    bodyText += `${size}\r\n${chunk}\r\n`;
  }
  bodyText += '0\r\n\r\n';
  return Buffer.concat([Buffer.from(headerText, 'ascii'), Buffer.from(bodyText, 'ascii')]);
}

// ── Tests: shouldBypassProxy ─────────────────────────────────────────────────

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

// ── Tests: formatError ───────────────────────────────────────────────────────

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
    const bodySection = err.message.split('Response:')[1] ?? '';
    expect(bodySection.length).toBeLessThanOrEqual(510);
  });
});

// ── Tests: parseRawHttpResponse ───────────────────────────────────────────────

describe('parseRawHttpResponse', () => {
  it('parses a simple 200 response with Content-Length', () => {
    const buf = buildHttpResponse(200, '{"ok":true}');
    const res = parseRawHttpResponse(buf);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it('parses status from a 401 response', () => {
    const buf = buildHttpResponse(401, 'Unauthorized');
    const res = parseRawHttpResponse(buf);
    expect(res.status).toBe(401);
    expect(res.body).toBe('Unauthorized');
  });

  it('parses headers into lowercase keys', () => {
    const buf = buildHttpResponse(200, 'hi', { 'X-Custom-Header': 'value123' });
    const res = parseRawHttpResponse(buf);
    expect(res.headers['x-custom-header']).toBe('value123');
  });

  it('throws on a response with no header/body separator', () => {
    expect(() => parseRawHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\n'))).toThrow('separator');
  });

  it('throws on an invalid status line', () => {
    expect(() => parseRawHttpResponse(Buffer.from('GARBAGE\r\n\r\nbody'))).toThrow('status line');
  });
});

// ── Tests: decodeChunked ─────────────────────────────────────────────────────

describe('decodeChunked', () => {
  it('reassembles multiple chunks into the full body', () => {
    const encoded = Buffer.from('5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n', 'ascii');
    expect(decodeChunked(encoded)).toBe('hello world');
  });

  it('handles a single chunk', () => {
    const encoded = Buffer.from('3\r\nabc\r\n0\r\n\r\n', 'ascii');
    expect(decodeChunked(encoded)).toBe('abc');
  });

  it('handles an empty body (immediate terminal chunk)', () => {
    const encoded = Buffer.from('0\r\n\r\n', 'ascii');
    expect(decodeChunked(encoded)).toBe('');
  });

  it('strips chunk extensions (;name=value)', () => {
    const encoded = Buffer.from('3;ext=x\r\nabc\r\n0\r\n\r\n', 'ascii');
    expect(decodeChunked(encoded)).toBe('abc');
  });
});

// ── Tests: tls.connect bypass path ───────────────────────────────────────────

describe('BaseHttpClient.request — tls.connect bypass path', () => {
  const tlsConnectMock = vi.mocked(tls.connect);

  beforeEach(() => {
    tlsConnectMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses tls.connect (not https.request) when host is in noProxy', async () => {
    makeConfigWithNoProxy(['corp.example.com']);
    const client = new TestClient();

    const fakeSocket = makeFakeSocket();
    tlsConnectMock.mockImplementation((_port: any, _host: any, _opts: any, cb: any) => {
      setImmediate(() => {
        cb();
        setImmediate(() => {
          fakeSocket.emit('data', buildHttpResponse(200, '{"id":1}'));
          fakeSocket.emit('end');
        });
      });
      return fakeSocket;
    });

    const res = await client.exposedRequest('https://corp.example.com/api/test');
    expect(tlsConnectMock).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"id":1}');
  });

  it('resolves chunked responses correctly via the bypass path', async () => {
    makeConfigWithNoProxy(['corp.example.com']);
    const client = new TestClient();

    const fakeSocket = makeFakeSocket();
    tlsConnectMock.mockImplementation((_port: any, _host: any, _opts: any, cb: any) => {
      setImmediate(() => {
        cb();
        setImmediate(() => {
          fakeSocket.emit('data', buildChunkedResponse(200, ['{"a":', '"b"}']));
          fakeSocket.emit('end');
        });
      });
      return fakeSocket;
    });

    const res = await client.exposedRequest('https://corp.example.com/api/chunked');
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"a":"b"}');
  });

  it('rejects when the socket emits an error', async () => {
    makeConfigWithNoProxy(['corp.example.com']);
    const client = new TestClient();

    const fakeSocket = makeFakeSocket();
    tlsConnectMock.mockImplementation((_port: any, _host: any, _opts: any, cb: any) => {
      setImmediate(() => {
        cb();
        setImmediate(() => {
          fakeSocket.emit('error', new Error('ECONNREFUSED'));
        });
      });
      return fakeSocket;
    });

    await expect(client.exposedRequest('https://corp.example.com/api/fail'))
      .rejects.toThrow('ECONNREFUSED');
  });

  it('passes rejectUnauthorized: false when allowInsecureTls is true', async () => {
    makeConfigWithNoProxy(['corp.example.com'], /* allowInsecureTls= */ true);
    const client = new TestClient();

    const fakeSocket = makeFakeSocket();
    let capturedTlsOpts: any;
    tlsConnectMock.mockImplementation((_port: any, _host: any, opts: any, cb: any) => {
      capturedTlsOpts = opts;
      setImmediate(() => {
        cb();
        setImmediate(() => {
          fakeSocket.emit('data', buildHttpResponse(200, 'ok'));
          fakeSocket.emit('end');
        });
      });
      return fakeSocket;
    });

    await client.exposedRequest('https://corp.example.com/api');
    expect(capturedTlsOpts.rejectUnauthorized).toBe(false);
  });

  it('passes rejectUnauthorized: true when allowInsecureTls is false (default)', async () => {
    makeConfigWithNoProxy(['corp.example.com'], /* allowInsecureTls= */ false);
    const client = new TestClient();

    const fakeSocket = makeFakeSocket();
    let capturedTlsOpts: any;
    tlsConnectMock.mockImplementation((_port: any, _host: any, opts: any, cb: any) => {
      capturedTlsOpts = opts;
      setImmediate(() => {
        cb();
        setImmediate(() => {
          fakeSocket.emit('data', buildHttpResponse(200, 'ok'));
          fakeSocket.emit('end');
        });
      });
      return fakeSocket;
    });

    await client.exposedRequest('https://corp.example.com/api');
    expect(capturedTlsOpts.rejectUnauthorized).toBe(true);
  });

  it('sends the PRIVATE-TOKEN header and correct request line over the raw socket', async () => {
    makeConfigWithNoProxy(['corp.example.com']);
    const client = new TestClient();

    const fakeSocket = makeFakeSocket();
    let capturedWrite: Buffer | undefined;
    fakeSocket.write = vi.fn((buf: Buffer) => { capturedWrite = buf; });

    tlsConnectMock.mockImplementation((_port: any, _host: any, _opts: any, cb: any) => {
      setImmediate(() => {
        cb();
        setImmediate(() => {
          fakeSocket.emit('data', buildHttpResponse(200, 'ok'));
          fakeSocket.emit('end');
        });
      });
      return fakeSocket;
    });

    await client.exposedRequest('https://corp.example.com/api/v4/projects', {
      headers: { 'PRIVATE-TOKEN': 'secret-token' },
    });

    const requestText = capturedWrite?.toString('utf8') ?? '';
    expect(requestText).toContain('PRIVATE-TOKEN: secret-token');
    expect(requestText).toContain('GET /api/v4/projects HTTP/1.1');
    expect(requestText).toContain('Connection: close');
    expect(requestText).toContain('Accept-Encoding: identity');
  });
});
