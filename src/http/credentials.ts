// src/http/credentials.ts
// Unified SecretStorage wrapper for GitLab, GitHub, and Jira credentials.
// All secrets stay in VS Code's SecretStorage — never written to settings or disk.

import * as vscode from 'vscode';

export type Service = 'gitlab' | 'github' | 'jira';

export class Credentials {
  constructor(private context: vscode.ExtensionContext) {}

  private key(service: Service, field: string): string {
    return `revvy.${service}.${field}`;
  }

  // ── Token-based auth (GitLab PAT, GitHub PAT) ────────────────────────────

  async getToken(service: Service): Promise<string | undefined> {
    return this.context.secrets.get(this.key(service, 'token'));
  }

  async setToken(service: Service, token: string): Promise<void> {
    await this.context.secrets.store(this.key(service, 'token'), token);
  }

  // ── Basic auth (Jira: username + API token) ──────────────────────────────

  async getBasicAuth(service: Service): Promise<{ user: string; token: string } | undefined> {
    const user  = await this.context.secrets.get(this.key(service, 'user'));
    const token = await this.context.secrets.get(this.key(service, 'token'));
    if (!user || !token) { return undefined; }
    return { user, token };
  }

  async setBasicAuth(service: Service, user: string, token: string): Promise<void> {
    await this.context.secrets.store(this.key(service, 'user'),  user);
    await this.context.secrets.store(this.key(service, 'token'), token);
  }

  // ── Credential removal ───────────────────────────────────────────────────

  async clear(service: Service): Promise<void> {
    await this.context.secrets.delete(this.key(service, 'token'));
    await this.context.secrets.delete(this.key(service, 'user'));
  }

  // ── Interactive prompts ──────────────────────────────────────────────────

  async promptForToken(service: Service): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      title:           `${service} access token`,
      prompt:          `Enter your ${service} personal access token`,
      password:        true,
      ignoreFocusOut:  true,
    });
    if (value) { await this.setToken(service, value); }
    return value;
  }

  async promptForBasicAuth(
    service: Service,
  ): Promise<{ user: string; token: string } | undefined> {
    const user = await vscode.window.showInputBox({
      title:           `${service} username`,
      prompt:          'Enter your username',
      ignoreFocusOut:  true,
    });
    if (!user) { return undefined; }

    const token = await vscode.window.showInputBox({
      title:           `${service} password or API token`,
      prompt:          'Enter your password or API token',
      password:        true,
      ignoreFocusOut:  true,
    });
    if (!token) { return undefined; }

    await this.setBasicAuth(service, user, token);
    return { user, token };
  }
}
