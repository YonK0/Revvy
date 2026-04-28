// src/http/jiraClient.ts
// Direct HTTP client for the Jira REST API (v2 and v3).
// Fetches issue metadata without requiring an MCP server.
// v2 returns description as plain text / wiki markup.
// v3 returns description as Atlassian Document Format (ADF) JSON — flattened here.

import * as vscode from 'vscode';
import { BaseHttpClient } from './baseClient';
import { Credentials } from './credentials';

export interface JiraTicket {
  key:         string;
  summary:     string;
  description: string;
  status:      string;
}

export class JiraClient extends BaseHttpClient {
  constructor(private credentials: Credentials) { super(); }

  // ── Config helpers ────────────────────────────────────────────────────────

  private getBaseUrl(): string {
    let url = vscode.workspace
      .getConfiguration('revvy.jira')
      .get<string>('baseUrl', '');
    if (!url) {
      throw new Error(
        'revvy.jira.baseUrl is not configured. ' +
        'Set it in VS Code settings (e.g. https://jira.example.com).',
      );
    }
    if (!/^https?:\/\//i.test(url)) { url = 'https://' + url; }
    return url.replace(/\/$/, '');
  }

  private getApiVersion(): string {
    return vscode.workspace
      .getConfiguration('revvy.jira')
      .get<string>('apiVersion', '2');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getAuth(): Promise<{ user: string; token: string }> {
    let auth = await this.credentials.getBasicAuth('jira');
    if (!auth) {
      auth = await this.credentials.promptForBasicAuth('jira');
      if (!auth) { throw new Error('Jira credentials are required for direct HTTP access.'); }
    }
    return auth;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async fetchTicket(key: string): Promise<JiraTicket> {
    const auth  = await this.getAuth();
    const basic = Buffer.from(`${auth.user}:${auth.token}`).toString('base64');
    const ver   = this.getApiVersion();
    const url   =
      `${this.getBaseUrl()}/rest/api/${ver}/issue/${key}` +
      `?fields=summary,description,status`;

    const res = await this.request(url, {
      headers: { Authorization: `Basic ${basic}` },
    });

    if (res.status === 401) {
      throw this.formatError(
        'Jira', url, 401, res.body,
        'username or token may be wrong — run "Revvy: Reset Jira Credentials" to re-enter',
      );
    }
    if (res.status === 404) {
      throw this.formatError(
        'Jira', url, 404, res.body,
        `issue "${key}" not found — check the ticket key and that the Jira base URL is correct`,
      );
    }
    if (res.status >= 400) {
      throw this.formatError('Jira', url, res.status, res.body);
    }

    const json = JSON.parse(res.body);
    return {
      key:         json.key as string,
      summary:     (json.fields?.summary as string) ?? '',
      description: this.extractDescription(json.fields?.description),
      status:      (json.fields?.status?.name as string) ?? 'Unknown',
    };
  }

  // ── Description extraction ────────────────────────────────────────────────

  /**
   * Handles both v2 (plain-text / wiki markup strings) and v3 (ADF JSON).
   */
  private extractDescription(desc: unknown): string {
    if (!desc) { return ''; }
    if (typeof desc === 'string') {
      // v2 path — normalise line endings from wiki markup
      return desc.replace(/\r\n/g, '\n').trim();
    }
    if (typeof desc === 'object') {
      // v3 path — flatten Atlassian Document Format tree to plain text
      return this.flattenAdf(desc).trim();
    }
    return '';
  }

  private flattenAdf(node: unknown): string {
    if (!node) { return ''; }
    if (typeof node === 'string') { return node; }
    if (typeof node !== 'object') { return ''; }

    const n = node as Record<string, unknown>;

    if (n['type'] === 'text') { return (n['text'] as string) ?? ''; }

    if (Array.isArray(n['content'])) {
      const parts = (n['content'] as unknown[]).map(child => this.flattenAdf(child));
      const type  = n['type'] as string | undefined;
      const sep   = (type === 'paragraph' || type === 'heading' || type === 'listItem')
        ? '\n'
        : '';
      return parts.join('') + sep;
    }

    return '';
  }
}
