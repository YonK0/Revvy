// src/http/githubClient.ts
// Direct HTTP client for the GitHub REST API.
// Fetches PR metadata and the raw unified diff without requiring an MCP server.

import * as vscode from 'vscode';
import { BaseHttpClient } from './baseClient';
import { Credentials } from './credentials';

export interface GitHubPR {
  number:        number;
  title:         string;
  body:          string;
  head:          { ref: string; sha: string };
  base:          { ref: string };
  html_url:      string;
  changed_files: number;
}

export class GitHubClient extends BaseHttpClient {
  constructor(private credentials: Credentials) { super(); }

  // ── Config helpers ────────────────────────────────────────────────────────

  private getBaseUrl(): string {
    let url = vscode.workspace
      .getConfiguration('revvy.github')
      .get<string>('baseUrl', 'https://api.github.com');
    if (!/^https?:\/\//i.test(url)) { url = 'https://' + url; }
    return url.replace(/\/$/, '');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    let token = await this.credentials.getToken('github');
    if (!token) {
      token = await this.credentials.promptForToken('github');
      if (!token) { throw new Error('GitHub token is required for direct HTTP access.'); }
    }
    return token;
  }

  // ── API call wrapper ──────────────────────────────────────────────────────

  private async apiCall(
    path:   string,
    accept: string = 'application/vnd.github.v3+json',
  ): Promise<{ body: string; json: unknown }> {
    const url   = `${this.getBaseUrl()}${path}`;
    const token = await this.getToken();

    const res = await this.request(url, {
      headers: {
        Authorization:        `Bearer ${token}`,
        Accept:               accept,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (res.status === 401) {
      throw this.formatError(
        'GitHub', url, 401, res.body,
        'token may be invalid or expired — run "Revvy: Reset GitHub Credentials" to re-enter',
      );
    }
    if (res.status === 404) {
      throw this.formatError(
        'GitHub', url, 404, res.body,
        'repository or PR not found — check owner, repo, and PR number',
      );
    }
    if (res.status >= 400) {
      throw this.formatError('GitHub', url, res.status, res.body);
    }

    const json = accept.includes('json') ? JSON.parse(res.body) : null;
    return { body: res.body, json };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async fetchPR(owner: string, repo: string, prNumber: number): Promise<GitHubPR> {
    const { json } = await this.apiCall(`/repos/${owner}/${repo}/pulls/${prNumber}`);
    return json as GitHubPR;
  }

  /**
   * Returns the raw unified diff for a PR (Content-Type: text/x-patch).
   * This is the same format that `normalizeRemoteDiff` expects.
   */
  async fetchDiff(owner: string, repo: string, prNumber: number): Promise<string> {
    const { body } = await this.apiCall(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      'application/vnd.github.v3.diff',
    );
    return body;
  }

  /**
   * Reads the raw content of a file at a specific ref (commit SHA or branch).
   * Uses the GitHub contents API: GET /repos/{owner}/{repo}/contents/{path}?ref={ref}
   * Returns the decoded UTF-8 text.  Throws on 404 or unexpected response shape.
   */
  async readFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<string> {
    // Encode each path segment individually so slashes are preserved as separators
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const { json } = await this.apiCall(
      `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );
    const data = json as { content?: string; encoding?: string };
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error(
        `readFileContent: unexpected response format for ${filePath} (encoding=${data.encoding})`,
      );
    }
    // GitHub wraps base64 with newlines every 60 chars — strip them before decoding
    return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  }
}
