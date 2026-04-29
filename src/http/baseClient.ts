// src/http/baseClient.ts
// Shared HTTP transport for all direct-API clients (GitLab, GitHub, Jira).
//
// Two send paths:
//
//   1. Normal path  — lib.request() (https/http). Used when the host is NOT
//      in the noProxy list. VS Code's @vscode/proxy-agent patches
//      http.ClientRequest at the constructor level, so the corporate Squid
//      proxy is transparently applied. This is the safe default.
//
//   2. Bypass path  — tls.connect() / net.connect(). Used when the host IS
//      in the noProxy list. Node's tls/net modules are NOT patched by VS
//      Code's proxy-agent, so this creates a genuine direct socket to the
//      server — equivalent to `curl --noproxy <host>`.

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as tls from 'tls';
import * as net from 'net';
import { URL } from 'url';

export interface HttpOptions {
  method?:    'GET' | 'POST';
  headers?:   Record<string, string>;
  body?:      string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status:  number;
  body:    string;
  headers: Record<string, string>;
}

// ── Module-level HTTP/1.1 response parser (used by bypass path) ──────────────

/**
 * Parses a raw HTTP/1.1 response buffer into status, headers, and body.
 * Handles both Transfer-Encoding: chunked and Content-Length / connection-close
 * body termination. We specify Accept-Encoding: identity on bypass requests,
 * so gzip/deflate decompression is never needed.
 */
export function parseRawHttpResponse(raw: Buffer): HttpResponse {
  // Find the \r\n\r\n separator between headers and body
  let headerEnd = -1;
  for (let i = 0; i < raw.length - 3; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd === -1) {
    throw new Error('Invalid HTTP response: no header/body separator (\\r\\n\\r\\n) found');
  }

  const headerText = raw.slice(0, headerEnd).toString('ascii');
  const bodyBuf    = raw.slice(headerEnd + 4);

  const lines       = headerText.split('\r\n');
  const statusMatch = lines[0].match(/^HTTP\/\d(?:\.\d)? (\d{3})/);
  if (!statusMatch) {
    throw new Error(`Invalid HTTP status line: ${lines[0]}`);
  }
  const status = parseInt(statusMatch[1], 10);

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
      const val = lines[i].slice(colonIdx + 1).trim();
      headers[key] = val;
    }
  }

  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  const body = transferEncoding.includes('chunked')
    ? decodeChunked(bodyBuf)
    : bodyBuf.toString('utf8');

  return { status, body, headers };
}

/**
 * Decodes an HTTP/1.1 chunked transfer-encoded body buffer.
 * Each chunk is: <hex-size>[; extensions]\r\n<data>\r\n
 * Terminated by a 0-size chunk.
 */
export function decodeChunked(input: Buffer): string {
  const parts: Buffer[] = [];
  let pos = 0;

  while (pos < input.length) {
    // Find the end of the chunk-size line
    let lineEnd = -1;
    for (let i = pos; i < input.length - 1; i++) {
      if (input[i] === 13 && input[i + 1] === 10) { lineEnd = i; break; }
    }
    if (lineEnd === -1) { break; }

    const sizeLine = input.slice(pos, lineEnd).toString('ascii').trim();
    // Strip optional chunk extensions (e.g. "; name=value")
    const semiIdx = sizeLine.indexOf(';');
    const sizeStr = semiIdx >= 0 ? sizeLine.slice(0, semiIdx) : sizeLine;
    const size    = parseInt(sizeStr, 16);

    if (isNaN(size) || size === 0) { break; }  // terminal chunk

    pos = lineEnd + 2;                          // skip \r\n after size
    if (pos + size > input.length) { break; }   // truncated — take what we have
    parts.push(input.slice(pos, pos + size));
    pos += size + 2;                            // skip chunk data + trailing \r\n
  }

  return Buffer.concat(parts).toString('utf8');
}

// ── BaseHttpClient ────────────────────────────────────────────────────────────

export class BaseHttpClient {
  // ── Proxy helpers ─────────────────────────────────────────────────────────

  protected getNoProxyHosts(): string[] {
    return vscode.workspace
      .getConfiguration('revvy.network')
      .get<string[]>('noProxy', []);
  }

  protected shouldBypassProxy(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return this.getNoProxyHosts().some(
        h => hostname === h || hostname.endsWith('.' + h),
      );
    } catch {
      return false;
    }
  }

  // ── Bypass path: raw tls.connect / net.connect ────────────────────────────

  /**
   * Sends a raw HTTP/1.1 request over a direct tls.connect (HTTPS) or
   * net.connect (HTTP) socket, completely bypassing VS Code's proxy-agent.
   *
   * This is functionally equivalent to `curl --noproxy <host>`.
   */
  private requestDirectTls(
    url:              string,
    parsed:           URL,
    isHttps:          boolean,
    opts:             HttpOptions,
    allowInsecureTls: boolean,
  ): Promise<HttpResponse> {
    const port     = parseInt(String(parsed.port || (isHttps ? 443 : 80)), 10);
    const hostname = parsed.hostname;
    const path     = parsed.pathname + parsed.search;
    const method   = opts.method ?? 'GET';
    const timeoutMs = opts.timeoutMs ?? 30_000;

    // Build the raw HTTP/1.1 request text.
    // Connection: close  — server closes after response; no keep-alive needed.
    // Accept-Encoding: identity — prevents gzip/deflate so body parsing is trivial.
    const requestHeaders: Record<string, string> = {
      'Host':            hostname,
      'User-Agent':      'Revvy-VSCode-Extension',
      'Accept':          'application/json',
      'Connection':      'close',
      'Accept-Encoding': 'identity',
      ...(opts.headers ?? {}),
    };

    let headerText = `${method} ${path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(requestHeaders)) {
      headerText += `${k}: ${v}\r\n`;
    }
    if (opts.body) {
      const bodyLen = Buffer.byteLength(opts.body, 'utf8');
      headerText += `Content-Length: ${bodyLen}\r\n`;
      headerText += `Content-Type: application/json\r\n`;
    }
    headerText += '\r\n';

    const requestBufs: Buffer[] = [Buffer.from(headerText, 'ascii')];
    if (opts.body) { requestBufs.push(Buffer.from(opts.body, 'utf8')); }
    const requestBuf = Buffer.concat(requestBufs);

    return new Promise<HttpResponse>((resolve, reject) => {
      const chunks: Buffer[] = [];

      const onConnect = (socket: net.Socket) => {
        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => {
          socket.destroy(new Error(`Request timeout after ${timeoutMs}ms — URL: ${url}`));
        });

        socket.write(requestBuf);

        socket.on('data',  (chunk: Buffer) => chunks.push(chunk));
        socket.on('error', reject);
        socket.on('end',   () => {
          try {
            resolve(parseRawHttpResponse(Buffer.concat(chunks)));
          } catch (e: any) {
            reject(new Error(`Failed to parse HTTP response from ${url}: ${e.message}`));
          }
        });
      };

      if (isHttps) {
        const socket = tls.connect(
          port,
          hostname,
          { servername: hostname, rejectUnauthorized: !allowInsecureTls },
          () => onConnect(socket),
        );
        socket.on('error', reject);
      } else {
        const socket = net.connect(port, hostname, () => onConnect(socket));
        socket.on('error', reject);
      }
    });
  }

  // ── Core request ──────────────────────────────────────────────────────────

  protected async request(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
    const parsed      = new URL(url);
    const isHttps     = parsed.protocol === 'https:';
    const bypassProxy = this.shouldBypassProxy(url);

    if (bypassProxy) {
      // Read allowInsecureTls here (not in constructor) so config changes take
      // effect without restarting VS Code.
      const allowInsecureTls = vscode.workspace
        .getConfiguration('revvy.network')
        .get<boolean>('allowInsecureTls', false);

      return this.requestDirectTls(url, parsed, isHttps, opts, allowInsecureTls);
    }

    // Normal path — goes through VS Code's proxy-agent (handles corporate proxies
    // for hosts not in noProxy).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib: any = isHttps ? https : http;

    const reqOptions: https.RequestOptions = {
      method:   opts.method ?? 'GET',
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers:  {
        'User-Agent': 'Revvy-VSCode-Extension',
        Accept:       'application/json',
        ...opts.headers,
      },
      timeout: opts.timeoutMs ?? 30_000,
    };

    return new Promise<HttpResponse>((resolve, reject) => {
      const req = lib.request(reqOptions, (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status:  res.statusCode ?? 0,
            body:    Buffer.concat(chunks).toString('utf8'),
            headers: res.headers as Record<string, string>,
          });
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(
          new Error(`Request timeout after ${opts.timeoutMs ?? 30_000}ms — URL: ${url}`),
        );
      });

      if (opts.body) { req.write(opts.body); }
      req.end();
    });
  }

  // ── Error formatting ──────────────────────────────────────────────────────

  protected formatError(
    service: string,
    url:     string,
    status:  number,
    body:    string,
    hint?:   string,
  ): Error {
    const lines = [
      `[Revvy] ${service} API error ${status}`,
      `  URL: ${url}`,
    ];
    if (hint) { lines.push(`  Hint: ${hint}`); }
    lines.push(`  Response: ${body.slice(0, 500)}`);
    const err = new Error(lines.join('\n'));
    (err as any).status = status;
    return err;
  }
}
