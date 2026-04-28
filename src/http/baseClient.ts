// src/http/baseClient.ts
// Shared HTTP transport for all direct-API clients (GitLab, GitHub, Jira).
//
// Uses Node's built-in https/http modules rather than the global fetch API so
// that the noProxy bypass (which requires per-request agent control) works
// correctly inside the VS Code extension host.

import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
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

export class BaseHttpClient {
  // ── Proxy helpers ────────────────────────────────────────────────────────

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

  // ── Core request ─────────────────────────────────────────────────────────

  protected async request(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lib: any = isHttps ? https : http;
    const bypassProxy = this.shouldBypassProxy(url);

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

    if (bypassProxy) {
      // Explicit agent with keepAlive — bypasses VS Code's proxy middleware
      reqOptions.agent = isHttps
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
    }

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

  // ── Error formatting ─────────────────────────────────────────────────────

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
    return new Error(lines.join('\n'));
  }
}
