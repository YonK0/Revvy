// src/http/gitlabClient.ts
// Direct HTTP client for GitLab REST API v4.
// Fetches MR metadata and paginated diff files without requiring an MCP server.

import * as vscode from 'vscode';
import { BaseHttpClient } from './baseClient';
import { Credentials } from './credentials';

export interface GitLabDiffFile {
  diff:          string;
  new_path:      string;
  old_path:      string;
  new_file:      boolean;
  renamed_file:  boolean;
  deleted_file:  boolean;
}

export interface GitLabMR {
  iid:            number;
  title:          string;
  description:    string;
  source_branch:  string;
  target_branch:  string;
  changes_count:  string;
  web_url:        string;
}

export class GitLabClient extends BaseHttpClient {
  constructor(private credentials: Credentials) { super(); }

  // ── Config helpers ────────────────────────────────────────────────────────

  private getBaseUrl(): string {
    let url = vscode.workspace
      .getConfiguration('revvy.gitlab')
      .get<string>('baseUrl', '');
    if (!url) {
      throw new Error(
        'revvy.gitlab.baseUrl is not configured. ' +
        'Set it in VS Code settings (e.g. https://gitlab.example.com).',
      );
    }
    if (!/^https?:\/\//i.test(url)) { url = 'https://' + url; }
    return url.replace(/\/$/, '');
  }

  private getApiVersion(): string {
    return vscode.workspace
      .getConfiguration('revvy.gitlab')
      .get<string>('apiVersion', 'v4');
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    let token = await this.credentials.getToken('gitlab');
    if (!token) {
      token = await this.credentials.promptForToken('gitlab');
      if (!token) { throw new Error('GitLab token is required for direct HTTP access.'); }
    }
    return token;
  }

  // ── API call wrapper ──────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async apiCall(path: string): Promise<any> {
    const base  = this.getBaseUrl();
    const ver   = this.getApiVersion();
    const url   = `${base}/api/${ver}${path}`;
    const token = await this.getToken();

    const res = await this.request(url, {
      headers: { 'PRIVATE-TOKEN': token },
    });

    if (res.status === 401) {
      throw this.formatError(
        'GitLab', url, 401, res.body,
        'token may be invalid or expired — run "Revvy: Reset GitLab Credentials" to re-enter',
      );
    }
    if (res.status === 404) {
      throw this.formatError(
        'GitLab', url, 404, res.body,
        'project or MR not found — check that the project ID and MR IID are correct',
      );
    }
    if (res.status >= 400) {
      throw this.formatError('GitLab', url, res.status, res.body);
    }

    return JSON.parse(res.body);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async fetchMR(projectId: string, mrIid: number): Promise<GitLabMR> {
    const encoded = encodeURIComponent(projectId);
    return this.apiCall(`/projects/${encoded}/merge_requests/${mrIid}`);
  }

  /**
   * Fetches all diff files for a GitLab MR, handling pagination automatically.
   * Returns at most 1 000 files (10 pages × 100) — a hard safety cap.
   * Falls back to the older /changes endpoint if /diffs returns 500.
   */
  async fetchDiffs(projectId: string, mrIid: number): Promise<GitLabDiffFile[]> {
    const encoded = encodeURIComponent(projectId);
    try {
      return await this.fetchDiffsViaNewEndpoint(encoded, mrIid);
    } catch (err: any) {
      if (err?.status === 500) {
        console.log('[Revvy] /diffs returned 500, falling back to /changes');
        return this.fetchDiffsViaChanges(encoded, mrIid);
      }
      throw err;
    }
  }

  /**
   * Paginated fetch via the newer /diffs endpoint (GitLab ≥15.x).
   * Returns bare GitLabDiffFile[].
   */
  private async fetchDiffsViaNewEndpoint(
    encoded: string,
    mrIid:   number,
  ): Promise<GitLabDiffFile[]> {
    const all: GitLabDiffFile[] = [];
    let page = 1;

    while (true) {
      const batch: GitLabDiffFile[] = await this.apiCall(
        `/projects/${encoded}/merge_requests/${mrIid}/diffs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) { break; }
      all.push(...batch);
      if (batch.length < 100) { break; }    // last page
      page++;
      if (page > 10) { break; }             // safety cap: 1 000 files
    }

    return all;
  }

  /**
   * Fallback fetch via the older /changes endpoint.
   * Returns {id, iid, changes: GitLabDiffFile[]} — we extract .changes.
   */
  private async fetchDiffsViaChanges(
    encoded: string,
    mrIid:   number,
  ): Promise<GitLabDiffFile[]> {
    const data = await this.apiCall(
      `/projects/${encoded}/merge_requests/${mrIid}/changes`,
    );
    const changes: GitLabDiffFile[] = Array.isArray(data.changes)
      ? data.changes
      : Array.isArray(data)
        ? data
        : [];
    return changes;
  }
}
