// src/panelProvider.ts
// WebView panel for displaying review results — Figma design integration

import { ReviewResult, ReviewComment, ReviewTest, ReviewSource } from './reviewer';
import * as vscode from 'vscode';

export class ReviewPanelProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _lastResult?: ReviewResult;

  constructor(private context: vscode.ExtensionContext) {}

  async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')]
    };
    webviewView.webview.html = this.getWelcomeHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.type) {
        case 'runReview':
          vscode.commands.executeCommand('revvy.reviewDiff');
          break;
        case 'selectProfile':
          vscode.commands.executeCommand('revvy.selectProfile');
          break;
        case 'openRules':
          vscode.commands.executeCommand('revvy.openRulesFolder');
          break;
        case 'setTicket':
          vscode.commands.executeCommand('revvy.setTicketRequirements');
          break;
        case 'reviewMultiMR':
          vscode.commands.executeCommand('revvy.reviewMultiMR');
          break;
        case 'changeModel':
          await vscode.workspace.getConfiguration('revvy')
            .update('selectedModelId', msg.modelId, vscode.ConfigurationTarget.Global);
          break;
        case 'requestModels': {
          const selectedModelId = vscode.workspace.getConfiguration('revvy').get<string>('selectedModelId', '');
          let models: Array<{ id: string; name: string }> = [];
          try {
            const raw: any[] = await (vscode.lm as any).selectChatModels({ vendor: 'copilot' });
            if (raw && raw.length > 0) {
              models = raw.map(m => ({ id: m.id, name: m.name }));
            }
          } catch { /* LM API not available */ }
          webviewView.webview.postMessage({ type: 'updateModels', models, selectedModelId });
          break;
        }
        case 'goHome':
          // Delegate to extension so it can inject the current requirements state
          vscode.commands.executeCommand('revvy.goHome');
          break;
        case 'clearRequirements':
          vscode.commands.executeCommand('revvy.clearTicketRequirements');
          break;
        case 'openFile':
          this.openFileAtLine(msg.file, msg.line);
          break;
        case 'copyMarkdown':
          if (this._lastResult) {
            vscode.env.clipboard.writeText(this.formatAsMarkdown(this._lastResult));
            vscode.window.showInformationMessage('Review copied to clipboard');
          }
          break;
        case 'setReviewMode':
          await this.context.workspaceState.update('revvy.reviewMode', msg.mode);
          break;
        case 'getReviewMode': {
          const savedMode = this.context.workspaceState.get<string>('revvy.reviewMode', 'per_file');
          webviewView.webview.postMessage({ type: 'reviewMode', mode: savedMode });
          break;
        }

        // ── Configuration screen ──────────────────────────────────────────────
        case 'openConfigure':
          await this.showConfigure();
          break;

        case 'saveGitlabUrl':
          await vscode.workspace.getConfiguration('revvy.gitlab')
            .update('baseUrl', msg.value, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'saveAck', field: 'gitlab-url' });
          break;

        case 'saveGitlabApiVer':
          await vscode.workspace.getConfiguration('revvy.gitlab')
            .update('apiVersion', msg.value, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'saveAck', field: 'gitlab-api-ver' });
          break;

        case 'saveGitlabToken':
          if (msg.value) {
            await this.context.secrets.store('revvy.gitlab.token', msg.value);
            webviewView.webview.postMessage({ type: 'saveAck', field: 'gitlab-token' });
          }
          break;

        case 'saveGithubUrl':
          await vscode.workspace.getConfiguration('revvy.github')
            .update('baseUrl', msg.value, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'saveAck', field: 'github-url' });
          break;

        case 'saveGithubToken':
          if (msg.value) {
            await this.context.secrets.store('revvy.github.token', msg.value);
            webviewView.webview.postMessage({ type: 'saveAck', field: 'github-token' });
          }
          break;

        case 'saveJiraUrl':
          await vscode.workspace.getConfiguration('revvy.jira')
            .update('baseUrl', msg.value, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'saveAck', field: 'jira-url' });
          break;

        case 'saveJiraApiVer':
          await vscode.workspace.getConfiguration('revvy.jira')
            .update('apiVersion', msg.value, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'saveAck', field: 'jira-api-ver' });
          break;

        case 'saveJiraUser':
          if (msg.value) {
            await this.context.secrets.store('revvy.jira.user', msg.value);
            webviewView.webview.postMessage({ type: 'saveAck', field: 'jira-user' });
          }
          break;

        case 'saveJiraToken':
          if (msg.value) {
            await this.context.secrets.store('revvy.jira.token', msg.value);
            webviewView.webview.postMessage({ type: 'saveAck', field: 'jira-token' });
          }
          break;

        case 'saveNoProxy': {
          const hosts = (msg.value as string)
            .split(',')
            .map((h: string) => h.trim())
            .filter((h: string) => h.length > 0);
          await vscode.workspace.getConfiguration('revvy.network')
            .update('noProxy', hosts, vscode.ConfigurationTarget.Global);
          webviewView.webview.postMessage({ type: 'saveAck', field: 'noproxy-hosts' });
          break;
        }
      }
    });
  }

  async showResult(result: ReviewResult) {
    this._lastResult = result;
    if (this._view) {
      try {
        // Build the HTML first — this does async file reads.
        // Only show/focus the panel after the HTML is ready so VS Code
        // doesn't render the loading screen again between show() and the
        // html assignment.
        const html = await this.getResultHtml(result);
        this._view.webview.html = html;
        this._view.show(true);
      } catch (e) {
        // Safety net: if getResultHtml throws for any reason, render the
        // lightweight fallback so the panel always escapes the loading screen.
        console.error('[Revvy] getResultHtml failed, using fallback render:', e);
        this._view.webview.html = this.getResultFallbackHtml(result);
        this._view.show(true);
      }
    }
  }

  showLoading() {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.html = this.getLoadingHtml('Initializing...', 0);
    }
  }

  /**
   * Full HTML rebuild — only call this for phase transitions (diff, rules, analyzing, done).
   * For high-frequency token-count updates use patchLoading() instead.
   */
  public updateLoading(status: string, progress: number) {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.html = this.getLoadingHtml(status, progress);
    }
  }

  /**
   * PERF — Lightweight live update: sends a postMessage to the already-rendered
   * loading screen to update only the status text and token counter.
   * Does NOT rebuild the WebView HTML, so it is safe to call on every token chunk.
   */
  public patchLoading(status: string, tokenCount: number, filesTotal: number, filesDone: number) {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'loadingPatch',
        status,
        tokenCount,
        filesTotal,
        filesDone,
      });
    }
  }

  public showLoadingError(message: string) {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.html = this.getLoadingErrorHtml(message);
    }
  }

  public showNoChanges() {
    if (this._view) {
      this._view.show?.(true);
      this._view.webview.html = this.getNoChangesHtml();
    }
  }

  private async openFileAtLine(file: string, line: number) {
    const fileUri = await this.resolveWorkspaceFileUri(file);
    if (!fileUri) {
      vscode.window.showWarningMessage(`Could not open: ${file}`);
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const editor = await vscode.window.showTextDocument(doc);
      if (line > 0) {
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      }
    } catch {
      vscode.window.showWarningMessage(`Could not open: ${file}`);
    }
  }

  private formatAsMarkdown(r: ReviewResult): string {
    const errors   = r.comments.filter(c => c.severity === 'error');
    const warnings = r.comments.filter(c => c.severity === 'warning');
    const infos    = r.comments.filter(c => c.severity !== 'error' && c.severity !== 'warning');

    const repoLine = (r.sources && r.sources.length > 0)
      ? r.sources.map(s => `${s.type === 'gitlab' ? 'GitLab MR' : 'GitHub PR'} #${s.mrNumber} (${s.repo})`).join(', ')
      : 'local workspace';

    let md = `You are a coding agent. Apply ALL of the fixes listed below to the codebase.\n`;
    md += `Do not ask for confirmation — just make the changes and stop.\n\n`;
    md += `---\n\n`;
    md += `## Context\n\n`;
    md += `- **Review profile:** ${r.profileUsed}\n`;
    md += `- **Source:** ${repoLine}\n`;
    md += `- **Verdict:** ${r.verdict} (score ${r.score}/10)\n`;
    md += `- **Model used:** ${r.modelUsed} via ${r.backendUsed}\n`;
    md += `- **Issues:** ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info\n\n`;

    if (r.summary) {
      md += `## Summary\n\n${r.summary}\n\n`;
    }

    if (r.comments.length > 0) {
      md += `---\n\n## Fixes Required\n\n`;
      let idx = 1;
      for (const c of r.comments) {
        const sev = c.severity === 'error' ? 'ERROR' : c.severity === 'warning' ? 'WARNING' : 'INFO';
        md += `### Fix ${idx++}: ${sev} in \`${c.file}\` at line ${c.line}\n\n`;
        if (c.ruleId || c.ruleTitle) {
          md += `**Rule:** ${[c.ruleId, c.ruleTitle].filter(Boolean).join(' — ')}\n\n`;
        }
        md += `**Issue:** ${c.message}\n\n`;
        if (c.suggestion) {
          md += `**Suggested fix:**\n\`\`\`\n${c.suggestion}\n\`\`\`\n\n`;
        }
      }
    }

    if (r.conclusion) {
      md += `---\n\n## Conclusion\n\n${r.conclusion}\n\n`;
    }

    if (r.tests && r.tests.length > 0) {
      md += `---\n\n## Integration Tests to Verify\n\n`;
      r.tests.forEach((t, i) => {
        const catLabel = t.category === 'security' ? '[Security]'
          : t.category === 'performance' ? '[Performance]'
          : t.category === 'functional' ? '[Functional]' : '[Boundary]';
        md += `**${catLabel} ${t.title || `Test ${i + 1}`}**\n`;
        t.steps.forEach((s, j) => { md += `${j + 1}. ${s}\n`; });
        md += '\n';
      });
    }

    if (r.commitMessages && r.commitMessages.length > 0) {
      md += `---\n\n## Suggested Commit Messages\n\n`;
      r.commitMessages.forEach((msg, i) => {
        md += `${i + 1}. \`${msg}\`\n`;
      });
      md += '\n';
    }

    md += `---\n\n*Apply every fix above. When done, confirm which files were changed.*\n`;
    return md;
  }

  // ──────────────────────────────────────────────────────────
  // Shared CSS for all views
  // ──────────────────────────────────────────────────────────
  private getSharedCss(): string {
    return `
/* ─── Globals ──────────────────────────────────────────────────────────────── */
:root {
  /* VS Code Native Integration with sleek fallbacks */
  --bg-canvas:      var(--vscode-editor-background, #0d1117);
  --bg-overlay:     var(--vscode-editorWidget-background, #161b22);
  --bg-subtle:      var(--vscode-tab-inactiveBackground, #21262d);
  --bg-muted:       var(--vscode-textBlockQuote-background, #30363d);
  --border-default: var(--vscode-panel-border, #30363d);
  --border-muted:   var(--vscode-editorGroup-border, #21262d);

  --fg-default:     var(--vscode-editor-foreground, #e6edf3);
  --fg-muted:       var(--vscode-descriptionForeground, #8b949e);
  --fg-subtle:      var(--vscode-textPreformat-foreground, #6e7681);
  --fg-on-emphasis: var(--vscode-button-foreground, #ffffff);

  --accent-fg:      var(--vscode-textLink-foreground, #58a6ff);
  --accent-emphasis: var(--vscode-button-background, #1f6feb);
  --accent-subtle:  rgba(31, 111, 235, 0.15);

  --diff-add-bg:    var(--vscode-diffEditor-insertedTextBackground, rgba(35, 134, 54, 0.15));
  --diff-add-line:  var(--vscode-diffEditor-insertedLineBackground, rgba(35, 134, 54, 0.25));
  --diff-add-fg:    var(--vscode-editorOverviewRuler-addedForeground, #3fb950);
  --diff-add-num:   rgba(35, 134, 54, 0.2);

  --diff-del-bg:    var(--vscode-diffEditor-removedTextBackground, rgba(248, 81, 73, 0.12));
  --diff-del-line:  var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.2));
  --diff-del-fg:    var(--vscode-editorOverviewRuler-deletedForeground, #f85149);
  --diff-del-num:   rgba(248, 81, 73, 0.18);

  --diff-hunk-bg:   rgba(88, 166, 255, 0.08);
  --diff-hunk-fg:   var(--vscode-editorOverviewRuler-infoForeground, #58a6ff);

  --sev-error:        var(--vscode-errorForeground, #660606);
  --sev-error-bg:     rgba(102, 6, 6, 0.10);
  --sev-error-border: var(--vscode-errorForeground, #660606);
  
  --sev-warn:       var(--vscode-editorWarning-foreground, #d29922);
  --sev-warn-bg:    rgba(210, 153, 34, 0.08);
  --sev-warn-border: var(--vscode-editorWarning-foreground, #d29922);
  
  --sev-info:       var(--vscode-editorInfo-foreground, #58a6ff);
  --sev-info-bg:    rgba(88, 166, 255, 0.08);
  --sev-info-border: var(--vscode-editorInfo-foreground, #58a6ff);

  --verdict-approve: var(--vscode-testing-iconPassed, #3fb950);
  --verdict-changes: var(--vscode-testing-iconFailed, #f85149);
  --verdict-discuss: var(--vscode-testing-iconQueued, #d29922);

  --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif);
  --font-mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace);

  /* ── Code block theming — adapts to dark / light / high-contrast themes ── */
  /* Background for code snippet blocks and suggested fix blocks.             */
  /* --vscode-textCodeBlock-background is VS Code's canonical "code block"   */
  /* background (used in Markdown preview) — present in every built-in theme. */
  --code-bg:         var(--vscode-textCodeBlock-background,
                         var(--vscode-editor-background, #0d1117));

  /* Line-number gutter — reuses the same token the editor gutter uses.      */
  --code-ln-bg:      var(--vscode-textCodeBlock-background,
                         var(--vscode-editor-background, #0d1117));
  --code-ln-fg:      var(--vscode-editorLineNumber-foreground,      #6e7681);
  --code-ln-active:  var(--vscode-editorLineNumber-activeForeground, #c9d1d9);
  --code-ln-border:  var(--vscode-editorIndentGuide-background,      #21262d);

  /* Flagged-line row highlight — same token the editor uses for cursor line. */
  --code-flagged-bg: var(--vscode-editor-lineHighlightBackground,
                         rgba(128, 128, 128, 0.07));

  /* Default code text color — tracks the editor foreground.                 */
  --code-text:       var(--vscode-editor-foreground, #c9d1d9);

  /* "Source unavailable" placeholder text.                                  */
  --code-unavail-fg: var(--vscode-disabledForeground,
                         var(--vscode-descriptionForeground, #6e7681));

  /* Suggested-fix block header bar — green tint from the diff theme.        */
  --fix-hdr-bg:      var(--vscode-diffEditor-insertedLineBackground,
                         rgba(35, 134, 54, 0.15));

  /* ── Syntax token colors — map to VS Code semantic / symbol icon tokens ── */
  /* These exist in every VS Code built-in theme (dark, light, HC-black,     */
  /* HC-light) and are set by theme extensions via contributes.colors.        */
  --tok-kw:  var(--vscode-symbolIcon-keywordForeground,   #c678dd); /* keywords    */
  --tok-str: var(--vscode-symbolIcon-stringForeground,    #98c379); /* strings     */
  --tok-num: var(--vscode-symbolIcon-numberForeground,    #d19a66); /* numbers     */
  --tok-cmt: var(--vscode-editorLineNumber-foreground,    #6e7681); /* comments    */
  --tok-op:  var(--vscode-editor-foreground,              #abb2bf); /* operators   */
}

body {
  font-family: var(--font-sans);
  color: var(--fg-default);
  background: var(--bg-canvas);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  margin: 0;
  padding: 0;
}

.panel { display: flex; flex-direction: column; height: 100vh; }
.panel-body { flex: 1; overflow-y: auto; padding: 0; }

/* ── Utility ── */
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }

/* ── Primary CTA ── */
.btn-primary {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  width: 100%; padding: 10px 16px;
  background: var(--accent-emphasis);
  color: var(--fg-on-emphasis);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px;
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background 0.12s, box-shadow 0.12s;
  letter-spacing: 0.01em;
}
.btn-primary:hover {
  background: #388bfd;
  box-shadow: 0 0 0 3px rgba(31,111,235,0.25);
}
.btn-primary:active { background: #1a7efb; }
.btn-primary svg { width: 15px; height: 15px; }
.btn-primary svg.logo-fill { stroke: none; fill: currentColor; }

/* ── Secondary actions ── */
.btn-secondary {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 9px 14px;
  background: var(--bg-subtle);
  color: var(--fg-default);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  font-size: 12px; cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  text-align: left;
}
.btn-secondary:hover {
  background: var(--bg-muted);
  border-color: #8b949e;
}
.btn-secondary .label-right {
  margin-left: auto; font-size: 11px;
  color: var(--fg-subtle);
  background: var(--bg-muted);
  padding: 1px 6px; border-radius: 20px;
}

/* SVG sizes */
.btn-secondary svg { width: 15px; height: 15px; stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }

/* ── Active requirements row ── */
  .btn-req-active { border-color: var(--accent-fg) !important; }
  .req-label-active { background: rgba(88,166,255,0.12); color: var(--accent-fg); }
  .req-clear-btn { margin-left:auto; display:flex; align-items:center; padding:2px 4px; border-radius:4px; color:var(--fg-subtle); background:transparent; border:none; cursor:pointer; }
  .req-clear-btn:hover { color:var(--fg-default); background:var(--bg-muted); }

.toolbar-btn svg  { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

/* ── Bottom bar / toolbar ── */
.bottom-bar {
  border-top: 1px solid var(--border-default);
  background: var(--bg-overlay);
  flex-shrink: 0;
}
.toolbar { display: flex; align-items: center; }
.toolbar-btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 9px 6px; background: none; border: none;
  color: var(--fg-muted); font-size: 11px; cursor: pointer;
  transition: color 0.12s, background 0.12s;
  font-family: var(--font-sans);
}
.toolbar-btn:hover { background: var(--bg-subtle); color: var(--fg-default); }
.toolbar-btn + .toolbar-btn { border-left: 1px solid var(--border-muted); }
.meta-footer {
  padding: 5px 14px; text-align: right;
  font-size: 10px; color: var(--fg-subtle);
  font-family: var(--font-mono);
  border-top: 1px solid var(--border-muted);
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--bg-muted); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #6e7681; }

/* ── Section labels ── */
.section-label {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; font-weight: 600; color: var(--fg-subtle);
  text-transform: uppercase; letter-spacing: 0.07em;
  margin-bottom: 10px;
}
.section-label::after {
  content: ''; flex: 1; height: 1px; background: var(--border-muted);
}

.issue-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}
.filter-group {
  display: inline-flex;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 999px;
  padding: 3px;
  gap: 4px;
}
.filter-chip {
  border: none;
  background: transparent;
  color: var(--fg-muted);
  font-size: 11px;
  padding: 5px 10px;
  border-radius: 999px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: background 0.12s, color 0.12s;
}
.filter-chip span {
  font-weight: 600;
  font-size: 10px;
  color: var(--fg-subtle);
}
.filter-chip.active {
  background: var(--accent-subtle);
  color: var(--accent-fg);
}
.filter-chip.active span {
  color: var(--accent-fg);
}

.issue-empty {
  margin-top: 8px;
  padding: 12px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-overlay);
  border: 1px dashed var(--border-default);
  border-radius: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.issue-empty svg {
  width: 16px;
  height: 16px;
  stroke: currentColor;
  fill: none;
}
#issuesEmptyState[hidden] {
  display: none;
}
.diff-review-card.is-hidden {
  display: none;
}
`;
  }

  // ──────────────────────────────────────────────────────────
  // SVG icon helpers (matching lucide icons from the design)
  // ──────────────────────────────────────────────────────────
  private icons = {
    revvy: `<svg class="logo-fill" viewBox="0 0 24 24"><path d="M12 2.2c.7 0 1.4.4 1.8 1.1l8 13.7c.8 1.4-.2 3-1.8 3H4c-1.6 0-2.6-1.6-1.8-3l8-13.7c.4-.7 1.1-1.1 1.8-1.1Zm-3.3 15h2.3v-3.8h1.5l2 3.8h2.5l-2.4-4.2c1.2-.5 2-1.7 2-3.1 0-1.9-1.4-3.2-3.5-3.2H8.7v10.5Zm2.3-5.8V8.9h1.8c1 0 1.5.5 1.5 1.2 0 .8-.5 1.3-1.5 1.3H11Z"/></svg>`,
    search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
    settings: `<svg viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
    folderOpen: `<svg viewBox="0 0 24 24"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
    clipboard: `<svg viewBox="0 0 24 24"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
    flask: `<svg viewBox="0 0 24 24"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16.5h10"/></svg>`,
    refreshCw: `<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
    home: `<svg viewBox="0 0 24 24"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
    copyClipboard: `<svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    xCircle: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>`,
    checkCircle: `<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>`,
    repoForked: `<svg viewBox="0 0 24 24"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`,
    alertTriangle: `<svg viewBox="0 0 24 24"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
    info: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
    lightbulb: `<svg viewBox="0 0 24 24"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
    loader: `<svg viewBox="0 0 24 24"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>`,
  };

  // ──────────────────────────────────────────────────────────
  // Welcome Screen
  // ──────────────────────────────────────────────────────────
  // ──────────────────────────────────────────────────────────
  // Public: re-render the welcome screen with current state.
  // Called by extension.ts after profile switch, requirements
  // set/clear, and after a review completes.
  // ──────────────────────────────────────────────────────────
  public showWelcome(requirementsActive = false, requirementsLabel = '') {
    if (this._view) {
      this._view.webview.html = this.getWelcomeHtml(
        this._view.webview,
        requirementsActive,
        requirementsLabel
      );
    }
  }

  // ──────────────────────────────────────────────────────────
  // Configuration Screen
  // ──────────────────────────────────────────────────────────

  public async showConfigure() {
    if (!this._view) { return; }
    // Read current base URLs from VS Code config (sync)
    const gitlabUrl    = vscode.workspace.getConfiguration('revvy.gitlab').get<string>('baseUrl', '');
    const gitlabApiVer = vscode.workspace.getConfiguration('revvy.gitlab').get<string>('apiVersion', 'v4');
    const githubUrl    = vscode.workspace.getConfiguration('revvy.github').get<string>('baseUrl', 'https://api.github.com');
    const jiraUrl      = vscode.workspace.getConfiguration('revvy.jira').get<string>('baseUrl', '');
    const jiraApiVer   = vscode.workspace.getConfiguration('revvy.jira').get<string>('apiVersion', '2');
    const noProxyArr   = vscode.workspace.getConfiguration('revvy.network').get<string[]>('noProxy', []);
    const noProxy      = noProxyArr.join(', ');
    // Check secret existence (bool only — values never leave SecretStorage)
    const hasGitlabToken = !!(await this.context.secrets.get('revvy.gitlab.token'));
    const hasGithubToken = !!(await this.context.secrets.get('revvy.github.token'));
    const hasJiraUser    = !!(await this.context.secrets.get('revvy.jira.user'));
    const hasJiraToken   = !!(await this.context.secrets.get('revvy.jira.token'));
    this._view.webview.html = this.getConfigureHtml({
      gitlabUrl, gitlabApiVer, githubUrl, jiraUrl, jiraApiVer, noProxy,
      hasGitlabToken, hasGithubToken, hasJiraUser, hasJiraToken,
    });
  }

  private getConfigureHtml(cfg: {
    gitlabUrl: string;
    gitlabApiVer: string;
    githubUrl: string;
    jiraUrl: string;
    jiraApiVer: string;
    noProxy: string;
    hasGitlabToken: boolean;
    hasGithubToken: boolean;
    hasJiraUser: boolean;
    hasJiraToken: boolean;
  }): string {
    const e = (s: string) => this.escapeHtml(s);
    const tokenPlaceholder = (has: boolean, hint: string) =>
      has ? 'Already saved — enter to replace' : hint;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${this.getSharedCss()}

  /* ── Configure-screen extras ── */
  .cfg-page { display:flex; flex-direction:column; min-height:100vh; }

  .cfg-header {
    display:flex; align-items:center; gap:10px;
    padding:14px 16px 12px;
    border-bottom:1px solid var(--border-muted);
    background:var(--bg-overlay);
    position:sticky; top:0; z-index:10;
  }
  .cfg-back-btn {
    display:flex; align-items:center; justify-content:center;
    width:28px; height:28px; padding:0;
    background:transparent; border:1px solid var(--border-default);
    border-radius:6px; cursor:pointer; color:var(--fg-muted);
    flex-shrink:0;
    transition:background 0.12s, color 0.12s;
  }
  .cfg-back-btn:hover { background:var(--bg-subtle); color:var(--fg-default); }
  .cfg-back-btn svg { width:14px; height:14px; stroke:currentColor; fill:none; stroke-width:2.5; stroke-linecap:round; stroke-linejoin:round; }
  .cfg-title { font-size:13px; font-weight:700; color:var(--fg-default); letter-spacing:-0.01em; }

  /* ── Cards ── */
  .cfg-body { padding:14px 14px 24px; display:flex; flex-direction:column; gap:14px; }
  .cfg-card {
    background:var(--bg-overlay);
    border:1px solid var(--border-default);
    border-radius:8px;
    overflow:hidden;
  }
  .cfg-card-header {
    display:flex; align-items:center; gap:9px;
    padding:10px 14px;
    background:var(--bg-subtle);
    border-bottom:1px solid var(--border-muted);
    font-size:12px; font-weight:700; color:var(--fg-default);
    letter-spacing:0.01em;
  }
  .cfg-card-header svg { width:16px; height:16px; flex-shrink:0; }

  /* ── Fields ── */
  .cfg-fields { padding:12px 14px; display:flex; flex-direction:column; gap:10px; }
  .cfg-field { display:flex; flex-direction:column; gap:4px; }
  .cfg-label {
    font-size:11px; font-weight:600; color:var(--fg-subtle);
    text-transform:uppercase; letter-spacing:0.06em;
  }
  .cfg-input-row { display:flex; align-items:center; gap:6px; }
  .cfg-input {
    flex:1;
    background:var(--bg-subtle);
    color:var(--fg-default);
    border:1px solid var(--border-default);
    border-radius:6px;
    padding:7px 10px;
    font-size:12px;
    font-family:var(--font-sans);
    transition:border-color 0.12s, box-shadow 0.12s;
  }
  .cfg-input::placeholder { color:var(--fg-subtle); opacity:0.8; }
  .cfg-input:focus { outline:none; border-color:var(--accent-fg); box-shadow:0 0 0 3px rgba(88,166,255,0.15); }
  .cfg-select {
    flex:1;
    background:var(--bg-subtle);
    color:var(--fg-default);
    border:1px solid var(--border-default);
    border-radius:6px;
    padding:7px 10px;
    font-size:12px;
    font-family:var(--font-sans);
    appearance:none; -webkit-appearance:none;
    cursor:pointer;
    transition:border-color 0.12s;
  }
  .cfg-select:focus { outline:none; border-color:var(--accent-fg); box-shadow:0 0 0 3px rgba(88,166,255,0.15); }
  .cfg-hint { font-size:10px; color:var(--fg-subtle); line-height:1.4; margin-top:1px; }

  /* ── Inline "Saved" ack badge ── */
  .cfg-ack {
    font-size:10px; font-weight:600; color:var(--verdict-approve);
    opacity:0; transition:opacity 0.2s;
    white-space:nowrap; flex-shrink:0;
  }
</style>
</head>
<body>
<div class="cfg-page">

  <!-- ── Header ── -->
  <div class="cfg-header">
    <button class="cfg-back-btn" onclick="vscode.postMessage({type:'goHome'})" title="Back to home">
      <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <span class="cfg-title">Configuration</span>
  </div>

  <div class="cfg-body">

    <!-- ── GitLab ── -->
    <div class="cfg-card">
      <div class="cfg-card-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51a.42.42 0 0 1 .11-.18.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z"/>
        </svg>
        GitLab
      </div>
      <div class="cfg-fields">
        <div class="cfg-field">
          <label class="cfg-label">Base URL</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="gitlab-url" type="url"
              value="${e(cfg.gitlabUrl)}"
              placeholder="https://gitlab.example.com" />
            <span class="cfg-ack" id="gitlab-url-ack">Saved</span>
          </div>
          <span class="cfg-hint">Leave empty to use MCP path instead</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">API Version</label>
          <div class="cfg-input-row">
            <select class="cfg-select" id="gitlab-api-ver">
              <option value="v4"${cfg.gitlabApiVer === 'v4' ? ' selected' : ''}>v4 (default)</option>
              <option value="v3"${cfg.gitlabApiVer === 'v3' ? ' selected' : ''}>v3 (legacy)</option>
            </select>
            <span class="cfg-ack" id="gitlab-api-ver-ack">Saved</span>
          </div>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Personal Access Token</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="gitlab-token" type="password"
              placeholder="${tokenPlaceholder(cfg.hasGitlabToken, 'Enter personal access token')}" />
            <span class="cfg-ack" id="gitlab-token-ack">Saved</span>
          </div>
          <span class="cfg-hint">Needs <code>api</code> + <code>read_user</code> scopes</span>
        </div>
      </div>
    </div>

    <!-- ── GitHub ── -->
    <div class="cfg-card">
      <div class="cfg-card-header">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
        </svg>
        GitHub
      </div>
      <div class="cfg-fields">
        <div class="cfg-field">
          <label class="cfg-label">Base URL</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="github-url" type="url"
              value="${e(cfg.githubUrl)}"
              placeholder="https://api.github.com" />
            <span class="cfg-ack" id="github-url-ack">Saved</span>
          </div>
          <span class="cfg-hint">Override only for GitHub Enterprise Server</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Personal Access Token</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="github-token" type="password"
              placeholder="${tokenPlaceholder(cfg.hasGithubToken, 'Enter personal access token')}" />
            <span class="cfg-ack" id="github-token-ack">Saved</span>
          </div>
          <span class="cfg-hint">Needs <code>repo</code> scope (or <code>read:org</code> for org repos)</span>
        </div>
      </div>
    </div>

    <!-- ── Jira ── -->
    <div class="cfg-card">
      <div class="cfg-card-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11.75 2.25 6 8l5.75 5.75L6 19.75"/>
          <path d="M18 2.25 12.25 8 18 13.75l-5.75 5.75" opacity=".45"/>
        </svg>
        Jira
      </div>
      <div class="cfg-fields">
        <div class="cfg-field">
          <label class="cfg-label">Base URL</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="jira-url" type="url"
              value="${e(cfg.jiraUrl)}"
              placeholder="https://jira.example.com" />
            <span class="cfg-ack" id="jira-url-ack">Saved</span>
          </div>
          <span class="cfg-hint">Leave empty to use MCP path instead</span>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">API Version</label>
          <div class="cfg-input-row">
            <select class="cfg-select" id="jira-api-ver">
              <option value="2"${cfg.jiraApiVer === '2' ? ' selected' : ''}>v2 — Server / Data Center</option>
              <option value="3"${cfg.jiraApiVer === '3' ? ' selected' : ''}>v3 — Cloud</option>
            </select>
            <span class="cfg-ack" id="jira-api-ver-ack">Saved</span>
          </div>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">Username</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="jira-user" type="text"
              placeholder="${tokenPlaceholder(cfg.hasJiraUser, 'Enter Jira username or email')}" />
            <span class="cfg-ack" id="jira-user-ack">Saved</span>
          </div>
        </div>
        <div class="cfg-field">
          <label class="cfg-label">API Token / Password</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="jira-token" type="password"
              placeholder="${tokenPlaceholder(cfg.hasJiraToken, 'Enter API token or password')}" />
            <span class="cfg-ack" id="jira-token-ack">Saved</span>
          </div>
          <span class="cfg-hint">Use an API token for Jira Cloud; password for Server/DC</span>
        </div>
      </div>
    </div>

    <!-- ── Network ── -->
    <div class="cfg-card">
      <div class="cfg-card-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="2" y1="12" x2="22" y2="12"/>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
        Network
      </div>
      <div class="cfg-fields">
        <div class="cfg-field">
          <label class="cfg-label">Proxy Bypass Hosts</label>
          <div class="cfg-input-row">
            <input class="cfg-input" id="noproxy-hosts" type="text"
              value="${e(cfg.noProxy)}"
              placeholder="gitlab.corp.example.com, jira.corp.example.com" />
            <span class="cfg-ack" id="noproxy-hosts-ack">Saved</span>
          </div>
          <span class="cfg-hint">Comma-separated hostnames that bypass the system proxy for direct HTTP calls</span>
        </div>
      </div>
    </div>

  </div><!-- /cfg-body -->

<script>
  const vscode = acquireVsCodeApi();

  // Flash the "Saved" ack label next to a field
  function showAck(fieldId) {
    const el = document.getElementById(fieldId + '-ack');
    if (!el) { return; }
    el.style.opacity = '1';
    setTimeout(function() { el.style.opacity = '0'; }, 1500);
  }

  // Listen for saveAck messages from the extension host
  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (msg.type === 'saveAck') { showAck(msg.field); }
  });

  // Auto-save text/url/password inputs on blur (only when value changed)
  function watchBlur(id, msgType) {
    const el = document.getElementById(id);
    if (!el) { return; }
    const original = el.value;
    let lastSent = original;
    el.addEventListener('blur', function() {
      const v = el.value; // do NOT trim passwords
      if (v !== lastSent) {
        lastSent = v;
        vscode.postMessage({ type: msgType, value: v });
      }
    });
  }

  // Auto-save select inputs on change immediately
  function watchChange(id, msgType) {
    const el = document.getElementById(id);
    if (!el) { return; }
    el.addEventListener('change', function() {
      vscode.postMessage({ type: msgType, value: el.value });
    });
  }

  watchBlur('gitlab-url',   'saveGitlabUrl');
  watchBlur('gitlab-token', 'saveGitlabToken');
  watchBlur('github-url',   'saveGithubUrl');
  watchBlur('github-token', 'saveGithubToken');
  watchBlur('jira-url',     'saveJiraUrl');
  watchBlur('jira-user',    'saveJiraUser');
  watchBlur('jira-token',   'saveJiraToken');
  watchBlur('noproxy-hosts','saveNoProxy');

  watchChange('gitlab-api-ver', 'saveGitlabApiVer');
  watchChange('jira-api-ver',   'saveJiraApiVer');
</script>
</body>
</html>`;
  }

  private getWelcomeHtml(
    webview: vscode.Webview,
    requirementsActive = false,
    requirementsLabel = ''
  ): string {
    const profile = vscode.workspace.getConfiguration('revvy').get<string>('activeProfile', 'c-embedded');
    const logoPngUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'home_icon.png')
    ).toString();

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${this.getSharedCss()}

  /* ── Hero ── */
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 28px 20px 20px;
    border-bottom: 1px solid var(--border-muted);
    background: linear-gradient(180deg, rgba(31,111,235,0.06) 0%, transparent 100%);
  }
  .hero-icon {
    width: auto;
    height: auto;
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 14px;
  }
  .hero-icon svg { width: 22px; height: 22px; stroke: var(--accent-fg); fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .hero-icon svg.logo-fill { stroke: none; fill: var(--accent-fg); }
  .hero-logo {
    width: 100px;
    height: 100px;
    object-fit: contain;
    display: block;
    filter:
      saturate(0.75)
      contrast(1.08)
      brightness(0.9)
      drop-shadow(0 6px 18px rgba(31, 111, 235, 0.28));
  }
  .hero-title {
    font-size: 16px; font-weight: 700;
    color: var(--fg-default); letter-spacing: -0.01em;
    margin-bottom: 4px;
  }
  .hero-sub {
    max-width: 260px;
    font-size: 12px; color: var(--fg-muted); margin-bottom: 16px; line-height: 1.5;
  }

  /* ── Profile chip ── */
  .profile-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 20px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    font-size: 11px; color: var(--fg-muted);
    margin-bottom: 18px;
  }
  .profile-chip span { color: var(--fg-default); font-weight: 500; }
  .profile-chip svg { width: 12px; height: 12px; stroke: var(--fg-subtle); fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }

  /* ── Action list ── */
  .actions {
    display: flex; flex-direction: column; gap: 6px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-muted);
  }

  /* ── Model selector section ── */
  .model-section {
    padding: 14px 20px;
  }
  .model-section-label {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; color: var(--fg-subtle);
    text-transform: uppercase; letter-spacing: 0.07em;
    margin-bottom: 10px;
  }
  .model-section-label svg { width: 12px; height: 12px; stroke: var(--fg-subtle); fill:none; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .model-select-wrap { position: relative; }
  .model-select-wrap::after {
    content: '';
    position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    width: 0; height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-top: 5px solid var(--fg-subtle);
    pointer-events: none;
  }
  .model-select {
    width: 100%;
    background: var(--bg-subtle);
    color: var(--fg-default);
    padding: 8px 32px 8px 12px;
    font-size: 12px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    appearance: none; -webkit-appearance: none;
    cursor: pointer;
    transition: border-color 0.12s, background 0.12s;
    font-family: var(--font-sans);
  }
  .model-select:hover { border-color: #8b949e; background: var(--bg-muted); }
  .model-select:focus { outline: none; border-color: var(--accent-fg); box-shadow: 0 0 0 3px rgba(88,166,255,0.15); }
  .model-select:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
  <div class="panel">
    <div class="panel-body">
      <!-- Hero -->
      <div class="hero">
        <div class="hero-icon"><img class="hero-logo" src="${logoPngUri}" alt="Revvy logo"/></div>
        <div class="hero-title">Revvy</div>
        <div class="hero-sub">AI-powered code review for your team.</div>
        <div class="profile-chip">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>
          Profile: <span>${this.escapeHtml(profile)}</span>
        </div>
        <button class="btn-primary" onclick="vscode.postMessage({type:'runReview'})">
          Review Current Diff
        </button>
      </div>

      <!-- Review mode selector -->
      <div class="model-section" style="border-bottom:1px solid var(--border-muted)">
        <div class="model-section-label">
          <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="7" rx="1"/><rect x="2" y="14" width="10" height="7" rx="1"/><rect x="16" y="14" width="6" height="7" rx="1"/></svg>
          Review mode
        </div>
        <div class="filter-group">
          <button id="mode-per-file" class="filter-chip active">Per file</button>
          <button id="mode-all-in-one" class="filter-chip">All in one</button>
        </div>
      </div>

      <!-- Secondary actions -->
      <div class="actions">
        <button class="btn-secondary" onclick="vscode.postMessage({type:'selectProfile'})">
          ${this.icons.settings}<span>Switch Profile</span>
        </button>
        <button class="btn-secondary" onclick="vscode.postMessage({type:'openRules'})">
          ${this.icons.folderOpen}<span>Open Rules Folder</span>
        </button>
        ${requirementsActive ? `
        <button class="btn-secondary btn-req-active" onclick="vscode.postMessage({type:'setTicket'})">
          ${this.icons.clipboard}<span>Set Requirements</span>
          <span class="label-right req-label-active">${this.escapeHtml(requirementsLabel)}</span>
          <span class="req-clear-btn" title="Clear requirements" onclick="event.stopPropagation();vscode.postMessage({type:'clearRequirements'})">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </span>
        </button>
        ` : `
        <button class="btn-secondary" onclick="vscode.postMessage({type:'setTicket'})">
          ${this.icons.clipboard}<span>Set Requirements</span>
          <span class="label-right">optional</span>
        </button>
        `}
        <button class="btn-secondary" onclick="vscode.postMessage({type:'reviewMultiMR'})">
          ${this.icons.repoForked}<span>Review Remote MRs</span>
          <span class="label-right">MCP</span>
        </button>
        <button class="btn-secondary" onclick="vscode.postMessage({type:'openConfigure'})" style="margin-top:4px;border-color:var(--border-default)">
          ${this.icons.settings}<span>Configuration</span>
          <span class="label-right">integrations</span>
        </button>
      </div>

      <!-- Model selector -->
      <div class="model-section">
        <div class="model-section-label">
          <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
          Copilot Model
        </div>
        <div class="model-select-wrap">
          <select class="model-select" id="modelSelect"
            onchange="vscode.postMessage({type:'changeModel', modelId: this.value})" disabled>
            <option value="">Loading models…</option>
          </select>
        </div>
      </div>
    </div>
    <p style="padding:12px 20px 16px;font-size:10px;color:var(--fg-subtle);margin:0;line-height:1.5">&#9432; &ldquo;All in one&rdquo; works best when the MR is small in both dimensions: fewer than ~5 files and under ~300 lines of diff. Use &ldquo;Per file&rdquo; otherwise.</p>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'updateModels') {
        const sel = document.getElementById('modelSelect');
        if (!sel) return;
        if (!msg.models || msg.models.length === 0) {
          sel.innerHTML = '<option value="">No Copilot models found</option>';
        } else {
          sel.innerHTML = msg.models.map(m =>
            '<option value="' + m.id + '"' + (m.id === msg.selectedModelId ? ' selected' : '') + '>' + m.name + '</option>'
          ).join('');
          sel.disabled = false;
        }
      }
      if (msg.type === 'reviewMode') {
        const pfb = document.getElementById('mode-per-file');
        const aiob = document.getElementById('mode-all-in-one');
        if (pfb && aiob) {
          pfb.classList.toggle('active', msg.mode === 'per_file');
          aiob.classList.toggle('active', msg.mode === 'all_in_one');
        }
      }
    });
    vscode.postMessage({ type: 'requestModels' });
    (function setupModeToggle() {
      const pfb = document.getElementById('mode-per-file');
      const aiob = document.getElementById('mode-all-in-one');
      if (!pfb || !aiob) { return; }
      function setMode(mode) {
        pfb.classList.toggle('active', mode === 'per_file');
        aiob.classList.toggle('active', mode === 'all_in_one');
        vscode.postMessage({ type: 'setReviewMode', mode: mode });
      }
      pfb.addEventListener('click', function() { setMode('per_file'); });
      aiob.addEventListener('click', function() { setMode('all_in_one'); });
      vscode.postMessage({ type: 'getReviewMode' });
    })();
  </script>
</body>
</html>`;
  }

  // ──────────────────────────────────────────────────────────
  // Loading Screen
  // ──────────────────────────────────────────────────────────
  private getLoadingHtml(status: string, progress: number): string {
    const progressPercent = Math.round(progress * 100);
    const steps = [
      { name: 'Fetching diff', percent: 0 },
      { name: 'Loading rules', percent: 25 },
      { name: 'Analyzing changes', percent: 50 },
      { name: 'Generating report', percent: 75 },
    ];
    const currentStep = steps.find(s => s.percent <= progressPercent);
    const currentStepPercent = currentStep?.percent || 0;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${this.getSharedCss()}

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
  @keyframes progress {
    0%   { width: 0%; opacity: 1; }
    80%  { width: 85%; opacity: 1; }
    100% { width: 85%; opacity: 0.7; }
  }

  .loader-wrap {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100vh; gap: 0;
    padding: 0 32px;
  }

  /* Spinner ring */
  .spinner-ring {
    width: 48px; height: 48px; margin-bottom: 20px;
    border: 2px solid var(--border-default);
    border-top-color: var(--accent-fg);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .loader-title {
    font-size: 14px; font-weight: 600;
    color: var(--fg-default);
    margin-bottom: 6px;
    letter-spacing: -0.01em;
  }
  .loader-sub {
    font-size: 12px; color: var(--fg-muted);
    margin-bottom: 24px; text-align: center;
    animation: pulse 2s ease-in-out infinite;
    min-height: 18px;
  }

  /* Progress bar */
  .progress-track {
    width: 100%; max-width: 220px; height: 3px;
    background: var(--bg-muted); border-radius: 99px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%; background: var(--accent-emphasis);
    border-radius: 99px;
    animation: progress 8s ease-out forwards;
  }

  /* Steps list */
  .steps {
    margin-top: 28px; display: flex; flex-direction: column; gap: 8px;
    width: 100%; max-width: 240px;
  }
  .step {
    display: flex; align-items: center; gap: 10px;
    font-size: 11px; color: var(--fg-subtle);
  }
  .step-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--bg-muted); flex-shrink: 0;
  }
  .step.active { color: var(--fg-muted); }
  .step.active .step-dot { background: var(--accent-fg); animation: pulse 1s ease-in-out infinite; }
  .step.done { color: var(--diff-add-fg); }
  .step.done .step-dot { background: var(--diff-add-fg); animation: none; }

  /* Live token / file counter */
  .live-counter {
    margin-top: 18px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--fg-subtle);
    text-align: center;
    min-height: 14px;
  }
</style>
</head>
<body>
  <div class="loader-wrap">
    <div class="spinner-ring"></div>
    <div class="loader-title">Running code review…</div>
    <div class="loader-sub" id="loaderSub">Analyzing diff</div>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="steps">
      <div class="step done"><div class="step-dot"></div>Fetching diff</div>
      <div class="step done"><div class="step-dot"></div>Loading rules</div>
      <div class="step active"><div class="step-dot"></div>Analyzing changes</div>
      <div class="step"><div class="step-dot"></div>Generating report</div>
    </div>
    <div class="live-counter" id="liveCounter"></div>
  </div>
  <script>
    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type !== 'loadingPatch') { return; }
      const sub = document.getElementById('loaderSub');
      if (sub) { sub.textContent = msg.status || ''; }
      const counter = document.getElementById('liveCounter');
      if (counter) {
        const parts = [];
        if (msg.tokenCount > 0) { parts.push(msg.tokenCount + ' tokens'); }
        if (msg.filesTotal > 1) { parts.push(msg.filesDone + '/' + msg.filesTotal + ' files'); }
        counter.textContent = parts.join('  ·  ');
      }
    });
  </script>
</body>
</html>`;
  }

  private getLoadingErrorHtml(message: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${this.getSharedCss()}

  .error-wrap {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100vh; gap: 0;
    padding: 0 32px;
  }

  .error-icon {
    font-size: 32px; margin-bottom: 16px;
  }

  .error-title {
    font-size: 14px; font-weight: 600;
    color: var(--sev-error-fg, var(--vscode-errorForeground, #f85149));
    margin-bottom: 10px;
    letter-spacing: -0.01em;
    text-align: center;
  }

  .error-message {
    font-size: 12px; color: var(--fg-muted);
    text-align: center; line-height: 1.6;
    max-width: 280px;
    background: var(--sev-error-bg, rgba(248, 81, 73, 0.08));
    border: 1px solid var(--sev-error-border, rgba(248, 81, 73, 0.3));
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 18px;
  }

  .error-actions {
    display: flex; gap: 8px; justify-content: center;
  }

  .go-home-btn, .try-again-btn {
    font-size: 12px; font-weight: 500;
    padding: 6px 14px; border-radius: 6px;
    border: 1px solid var(--border-default);
    cursor: pointer; font-family: var(--font-sans);
    transition: opacity 0.15s;
  }

  .go-home-btn {
    background: var(--bg-subtle); color: var(--fg-default);
  }

  .try-again-btn {
    background: var(--accent-emphasis, #1f6feb);
    color: #fff; border-color: transparent;
  }

  .go-home-btn:hover, .try-again-btn:hover { opacity: 0.85; }
</style>
</head>
<body>
  <div class="error-wrap">
    <div class="error-icon">⚠️</div>
    <div class="error-title">Could not fetch diff</div>
    <div class="error-message">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    <div class="error-actions">
      <button class="go-home-btn"
        onclick="acquireVsCodeApi().postMessage({type:'goHome'})">Back to Home</button>
      <button class="try-again-btn"
        onclick="acquireVsCodeApi().postMessage({type:'runReview'})">Try Again</button>
    </div>
  </div>
</body>
</html>`;
  }

  private getNoChangesHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${this.getSharedCss()}

  .no-changes-wrap {
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; height: 100vh; gap: 0;
    padding: 0 32px;
  }

  .no-changes-icon {
    font-size: 32px; margin-bottom: 16px;
  }

  .no-changes-title {
    font-size: 14px; font-weight: 600;
    color: var(--vscode-foreground);
    margin-bottom: 10px;
    letter-spacing: -0.01em;
    text-align: center;
  }

  .no-changes-sub {
    font-size: 12px; color: var(--fg-muted);
    text-align: center; line-height: 1.6;
    max-width: 280px;
  }

  .go-home-btn {
    margin-top: 20px;
    padding: 6px 16px;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
  }

  .go-home-btn:hover {
    background: var(--vscode-button-hoverBackground);
  }
</style>
</head>
<body>
  <div class="no-changes-wrap">
    <div class="no-changes-icon">📭</div>
    <div class="no-changes-title">No changes to review</div>
    <div class="no-changes-sub">There are no staged or unstaged changes in this repository.</div>
    <button class="go-home-btn" onclick="acquireVsCodeApi().postMessage({ type: 'goHome' })">Back to Home</button>
  </div>
</body>
</html>`;
  }

  // ──────────────────────────────────────────────────────────
  // Fallback Results Screen (no file reads — always safe to render)
  // Used when getResultHtml() throws so the panel never stays on
  // the loading screen.
  // ──────────────────────────────────────────────────────────
  private getResultFallbackHtml(r: ReviewResult): string {
    const verdictColor = r.verdict === 'APPROVE'
      ? 'var(--verdict-approve, #3fb950)'
      : r.verdict === 'REQUEST_CHANGES'
        ? 'var(--verdict-changes, #f85149)'
        : 'var(--verdict-discuss, #d29922)';

    const commentsHtml = r.comments.map(c => {
      const sev = c.severity === 'error' ? 'ERROR' : c.severity === 'warning' ? 'WARNING' : 'INFO';
      return `<div style="padding:8px 10px;border-bottom:1px solid var(--border-muted,#21262d);font-size:12px">
        <span style="font-weight:600;color:${c.severity === 'error' ? 'var(--sev-error,#f85149)' : 'var(--fg-muted,#8b949e)'}">[${sev}]</span>
        <span style="font-family:monospace;color:var(--fg-subtle,#6e7681);margin:0 6px">${this.escapeHtml(c.file)}:${c.line}</span>
        <span style="color:var(--fg-default,#e6edf3)">${this.escapeHtml(c.message)}</span>
      </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); background: var(--vscode-editor-background, #0d1117); color: var(--vscode-editor-foreground, #e6edf3); margin: 0; padding: 0; font-size: 13px; }
  ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
</style>
</head>
<body>
  <div style="padding:14px 12px;border-bottom:1px solid var(--border-default,#30363d);display:flex;align-items:center;gap:10px">
    <span style="font-size:14px;font-weight:700;color:${verdictColor}">${this.escapeHtml(r.verdict)}</span>
    <span style="font-size:13px;color:var(--fg-muted,#8b949e)">${r.score}/10</span>
    <span style="margin-left:auto;font-size:11px;color:var(--fg-subtle,#6e7681)">${this.escapeHtml(r.backendUsed)} · ${(r.durationMs / 1000).toFixed(1)}s</span>
  </div>
  ${r.summary ? `<div style="padding:10px 12px;font-size:12px;color:var(--fg-muted,#8b949e);border-bottom:1px solid var(--border-muted,#21262d)">${this.escapeHtml(r.summary)}</div>` : ''}
  <div>${commentsHtml}</div>
  ${r.conclusion ? `<div style="padding:10px 12px;font-size:12px;color:var(--fg-muted,#8b949e)">${this.escapeHtml(r.conclusion)}</div>` : ''}
  <div style="padding:10px 12px;border-top:1px solid var(--border-default,#30363d);display:flex;gap:8px">
    <button onclick="acquireVsCodeApi().postMessage({type:'goHome'})" style="padding:5px 12px;font-size:11px;border-radius:6px;border:1px solid var(--border-default,#30363d);background:transparent;color:var(--fg-muted,#8b949e);cursor:pointer">Home</button>
    <button onclick="acquireVsCodeApi().postMessage({type:'runReview'})" style="padding:5px 12px;font-size:11px;border-radius:6px;border:1px solid var(--border-default,#30363d);background:transparent;color:var(--fg-muted,#8b949e);cursor:pointer">Re-run</button>
  </div>
<script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }

  // ──────────────────────────────────────────────────────────
  // Results Screen  (Figma design integrated)
  // ──────────────────────────────────────────────────────────
  private async getResultHtml(r: ReviewResult): Promise<string> {
    // Counts
    const errorCount = r.comments.filter(c => c.severity === 'error').length;
    const warnCount  = r.comments.filter(c => c.severity === 'warning').length;
    const infoCount  = r.comments.filter(c => c.severity === 'suggestion' || c.severity === 'praise').length;
    const filesCount = new Set(r.comments.map(c => c.file)).size;

    const profileShort = this.escapeHtml(r.profileUsed);
    const modelShort   = this.escapeHtml(r.modelUsed.split('/').pop() ?? r.modelUsed);

    // Detect remote review (diff came from GitHub/GitLab MCP, not local git).
    // Remote reviews: skip local file reads — files don't exist in the workspace.
    const isRemote = !!(r.sources?.length && r.sources[0].type !== 'local');

    // FIX 4 — pre-read all unique files in parallel before rendering.
    // Previously getFileLines() was called inside renderComment() which runs
    // once per comment: 10 comments referencing 3 files = 10 serial readFile
    // calls. Now we read each unique file once and cache lines in a Map.
    const uniqueFilePaths = [...new Set(r.comments.map(c => c.file).filter(f => f && f !== 'general'))];
    const fileLinesCache = new Map<string, string[] | undefined>();
    if (!isRemote) {
      await Promise.all(
        uniqueFilePaths.map(async (fp) => {
          fileLinesCache.set(fp, await this.getFileLines(fp));
        })
      );
    }

    // ── Comment renderer ──
    const renderComment = (c: ReviewComment): string => {
      const sev  = c.severity === 'error' ? 'error' : c.severity === 'warning' ? 'warning' : 'note';
      const icon = sev === 'error' ? this.icons.xCircle
        : sev === 'warning' ? this.icons.alertTriangle : this.icons.info;
      const escapedFile    = this.escapeHtml(c.file);
      // For non-error severities, keep only the first sentence to stay concise
      const shortMsg = (c.severity !== 'error')
        ? this.firstSentence(c.message)
        : c.message;
      const escapedMsg     = this.renderInlineCode(this.escapeHtml(shortMsg));
      const escapedRule    = c.ruleTitle ? this.escapeHtml(c.ruleTitle) : '';

      // Render suggestion as a syntax-highlighted code block.
      // The AI returns raw code lines joined by \n (no fences).
      // Defensively strip any stray markdown fences the model may still emit.
      let fixLang  = '';
      let fixCode  = '';
      if (c.suggestion) {
        let raw = c.suggestion.trim();
        // Strip leading ```lang or ``` fence
        const openFence = raw.match(/^```(\w*)\r?\n/);
        if (openFence) {
          fixLang = openFence[1] || '';
          raw = raw.slice(openFence[0].length);
        }
        // Strip trailing ``` fence
        raw = raw.replace(/\r?\n```\s*$/, '');
        fixCode = raw
          .split('\n')
          .map(line => this.highlightCode(line) || '&nbsp;')
          .join('\n');
      }

      const lineRange      = c.endLine && c.endLine !== c.line ? `L${c.line}–${c.endLine}` : `L${c.line}`;
      // FIX 4: use pre-cached lines — no redundant readFile per comment.
      // For remote reviews, render from the diff context stored on the comment.
      let codeSnippet: string;
      if (isRemote) {
        // Part 3 fix: show file + line info in fallback instead of generic message
        codeSnippet = c.codeContext
          ? this.renderDiffContext(c.codeContext, c.codeContextStartLine ?? c.line, c.line, c.endLine, c.codeFragment)
          : `<div class="card-code-unavailable">Diff unavailable for ${escapedFile} line ${c.line}.</div>`;
      } else {
        const fileLines = fileLinesCache.get(c.file);
        codeSnippet = this.renderCodeLine(fileLines, c.line, c.endLine, c.codeFragment);
      }

      // Remote cards are inert — no local file to navigate to.
      const cardInteraction = isRemote
        ? `style="cursor:default" title="${escapedFile}"`
        : `onclick="openFile('${this.escapeJs(c.file)}', ${c.line})" title="Open ${escapedFile}"`;

      return `
      <div class="review-card sev-${sev}" data-sev="${sev}"
           ${cardInteraction}>
        <div class="card-file-bar">
          <svg class="card-file-icon" viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
          <span class="card-file-path" title="${escapedFile}">${escapedFile}</span>
          <span class="card-file-line">${lineRange}</span>
        </div>
        ${codeSnippet}
        <div class="card-thread" onclick="event.stopPropagation()">
          <div class="card-thread-header">
            <span class="sev-badge sev-badge-${sev}">
              <span class="sev-icon">${icon}</span>
              <span class="sev-label">${sev === 'note' ? 'INFO' : sev.toUpperCase()}</span>
            </span>
            ${escapedRule ? `<span class="card-rule">${escapedRule}</span>` : ''}
          </div>
          <p class="card-comment-body">${escapedMsg}</p>
          ${fixCode ? `
          <div class="card-fix-wrap">
            <div class="card-fix-header">
              <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              Suggested fix${fixLang ? ` <span class="card-fix-lang">${this.escapeHtml(fixLang)}</span>` : ''}
            </div>
            <pre class="card-fix-code">${fixCode}</pre>
          </div>` : ''}
        </div>
      </div>`;
    };

    const commentsHtml = r.comments.map(renderComment).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  ${this.getSharedCss()}

  /* ── Sticky Header ── */
  .sticky-header {
    position: sticky; top: 0; z-index: 50;
    height: 44px; background: var(--bg-overlay);
    border-bottom: 1px solid var(--border-default);
    display: flex; align-items: center;
    padding: 0 12px; justify-content: space-between; gap: 10px;
  }
  .sticky-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; overflow: hidden; }
  .sticky-left svg { width: 14px; height: 14px; stroke: var(--fg-muted); fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }
  .sticky-repo { font-size: 13px; font-weight: 500; color: var(--fg-default); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sticky-branch { padding: 2px 8px; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 99px; font-size: 11px; color: var(--fg-muted); white-space: nowrap; flex-shrink: 0; }
  .sticky-rerun { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border: 1px solid var(--border-default); border-radius: 6px; background: transparent; color: var(--fg-muted); font-size: 11px; cursor: pointer; flex-shrink: 0; transition: border-color 0.12s, color 0.12s; font-family: var(--font-sans); }
  .sticky-rerun:hover { border-color: var(--fg-muted); color: var(--fg-default); }
  .sticky-rerun svg { width: 12px; height: 12px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

  /* ── Hero Stats Bar (flat, no card frame) ── */
  .hero-bar {
    display: flex; align-items: center; gap: 0;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-muted);
  }
  .hero-stat {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    border-right: 1px solid var(--border-muted);
  }
  .hero-stat:first-child { padding-left: 2px; }
  .hero-stat:last-child  { border-right: none; }
  .hero-stat-val   { font-size: 13px; font-weight: 700; line-height: 1; }
  .hero-stat-label { font-size: 11px; color: var(--fg-subtle); }

  /* ── Filter Pills ── */
  .filter-pills-row { display: flex; gap: 4px; flex-wrap: wrap; padding: 8px 10px 0; }
  .filter-pill {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 9px; border-radius: 6px;
    border: 1px solid var(--border-default);
    background: var(--bg-subtle);
    color: var(--fg-muted); font-size: 11px; font-weight: 500;
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
    font-family: var(--font-sans);
  }
  .filter-pill svg { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .filter-pill .pill-count { font-weight: 600; font-size: 10px; color: var(--fg-subtle); }
  .filter-pill:hover { background: var(--bg-muted); border-color: var(--fg-subtle); color: var(--fg-default); }
  .filter-pill.fp-active-all     { background: var(--bg-muted); border-color: var(--fg-subtle); color: var(--fg-default); }
  .filter-pill.fp-active-error   { background: var(--bg-muted); border-color: var(--sev-error); color: var(--sev-error); }
  .filter-pill.fp-active-warning { background: var(--bg-muted); border-color: var(--fg-subtle);  color: var(--fg-default); }
  .filter-pill.fp-active-note    { background: var(--bg-muted); border-color: var(--fg-subtle);  color: var(--fg-muted); }

  /* ── Review Cards ── */
  .review-cards-list { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px 10px; }
  .review-card {
    background: var(--bg-overlay);
    border: 1px solid var(--border-default);
    border-radius: 8px; overflow: hidden;
    cursor: pointer;
    transition: border-color 0.12s;
  }
  .review-card:hover { border-color: var(--fg-subtle); }
  .review-card.is-hidden   { display: none; }

  /* File bar */
  .card-file-bar {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 10px;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border-default);
  }
  .card-file-icon { width: 11px; height: 11px; stroke: var(--fg-subtle); fill: none; stroke-width: 1.5; flex-shrink: 0; }
  .card-file-path { font-family: var(--font-mono); font-size: 10px; color: var(--fg-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-file-line { padding: 1px 5px; background: var(--bg-canvas); border: 1px solid var(--border-muted); border-radius: 4px; font-size: 9px; color: var(--fg-subtle); font-family: var(--font-mono); flex-shrink: 0; }

  /* ── Code line snippet ───────────────────────────────────────────── */
  .card-code-block {
    margin: 0;
    padding: 4px 0;
    border-top: 1px solid var(--border-default);
    border-bottom: 1px solid var(--border-default);
    overflow-x: auto;
    background: var(--code-bg);
  }
  .card-code-row {
    display: flex;
    align-items: stretch;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.7;
    min-width: max-content;
  }
  .card-code-ln {
    min-width: 40px;
    padding: 2px 10px 2px 6px;
    text-align: right;
    color: var(--code-ln-fg);
    background: var(--code-ln-bg);
    border-right: 2px solid var(--code-ln-border);
    user-select: none;
    flex-shrink: 0;
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  /* Context rows are dimmed; flagged row is highlighted */
  .card-code-row-ctx  { opacity: 0.45; }
  .card-code-row-flagged { background: var(--code-flagged-bg); }
  .card-code-ln-flagged  { color: var(--code-ln-active) !important; }
  /* Syntax token colors — mapped to VS Code theme tokens */
  .tok-kw  { color: var(--tok-kw); }
  .tok-str { color: var(--tok-str); }
  .tok-num { color: var(--tok-num); }
  .tok-cmt { color: var(--tok-cmt); font-style: italic; }
  .tok-op  { color: var(--tok-op); }
  .card-code-unavailable {
    padding: 6px 12px;
    font-size: 11px; color: var(--code-unavail-fg); font-style: italic;
    font-family: var(--font-mono);
    background: var(--code-bg);
    border-top: 1px solid var(--border-default);
    border-bottom: 1px solid var(--border-default);
  }

  /* Card thread (message + badge) */
  .card-thread { padding: 8px 10px 10px; }
  .card-thread-header { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
  .sev-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 6px; border-radius: 4px;
    border: 1px solid var(--border-default);
    background: var(--bg-subtle);
    font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
    color: var(--fg-muted);
    flex-shrink: 0;
  }
  .sev-badge-error   { border-color: var(--sev-error); color: var(--sev-error); background: var(--sev-error-bg); }
  .sev-badge-warning { border-color: var(--border-default); color: var(--fg-muted); }
  .sev-badge-note    { border-color: var(--border-muted);  color: var(--fg-subtle); }
  .sev-icon svg { width: 9px; height: 9px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .card-rule { font-size: 10px; color: var(--fg-subtle); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-comment-body { font-size: 12px; color: var(--fg-default); line-height: 1.6; margin: 0; }

  /* ── Suggested fix block ─────────────────────────────────────────── */
  [hidden] { display: none !important; }
  .card-fix-wrap {
    margin: 10px 0 0 0;
    border: 1px solid rgba(46, 160, 67, 0.15);
    border-radius: 6px;
    overflow: hidden;
    background: #0d1117;
  }
  .card-fix-header {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    background: #111b16;
    border-bottom: 1px solid rgba(46, 160, 67, 0.15);
    font-size: 10px; font-weight: 600;
    color: #3fb950;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    user-select: none;
  }
  .card-fix-header svg {
    width: 11px; height: 11px;
    stroke: #3fb950; fill: none;
    stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
    flex-shrink: 0;
  }
  .card-fix-lang {
    margin-left: 5px;
    padding: 0 5px;
    background: rgba(63,185,80,0.12);
    border: 1px solid rgba(63,185,80,0.25);
    border-radius: 3px;
    font-size: 9px;
    font-family: var(--font-mono);
    color: #3fb950;
    letter-spacing: 0.04em;
    text-transform: lowercase;
  }
  .card-fix-code {
    margin: 0;
    padding: 8px 14px 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: #c9d1d9;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.7;
    overflow-x: auto;
  }
  /* Prose suggestion — light callout, no code styling */
  .card-fix-prose {
    margin: 10px 0 0 0;
    padding: 7px 11px 8px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    font-size: 12px;
    color: var(--fg-default);
    line-height: 1.65;
  }
  .card-fix-prose-label {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 10px; font-weight: 600;
    color: #3fb950;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 4px;
    user-select: none;
  }
  .card-fix-prose-label svg {
    width: 10px; height: 10px;
    stroke: #3fb950; fill: none;
    stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round;
    flex-shrink: 0;
  }
  /* Inline code spans inside message / prose fix */
  .inline-code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-default);
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    border-radius: 3px;
    padding: 0 4px;
  }

  /* ── Empty State ── */
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; gap: 10px; }
  .empty-state-circle { width: 56px; height: 56px; border-radius: 50%; background: var(--bg-subtle); border: 1px solid var(--border-default); display: flex; align-items: center; justify-content: center; }
  .empty-state-circle svg { width: 26px; height: 26px; stroke: var(--fg-muted); fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .empty-state-title { font-size: 13px; font-weight: 600; color: var(--fg-default); }
  .empty-state-sub   { font-size: 11px; color: var(--fg-muted); text-align: center; }

  /* ── Filter empty notice ── */
  .filter-empty { padding: 14px; text-align: center; font-size: 11px; color: var(--fg-muted); background: var(--bg-overlay); border: 1px dashed var(--border-default); border-radius: 8px; }

  /* ── Sources banner ── */
  .sources-banner { margin: 10px 10px 0; padding: 8px 12px; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 6px; }
  .sources-banner-label { font-size: 10px; font-weight: 600; color: var(--fg-subtle); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .source-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; margin: 2px 4px 2px 0; background: var(--bg-overlay); border: 1px solid var(--border-default); border-radius: 4px; font-size: 11px; color: var(--fg-muted); }
  .source-chip svg { width: 11px; height: 11px; stroke: currentColor; fill: none; stroke-width: 2; }

  /* ── Tests section ── */
  .section-label { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; color: var(--fg-subtle); text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 4px; }
  .section-label::after { content: ''; flex: 1; height: 1px; background: var(--border-muted); }
</style>
</head>
<body>
<div class="panel">
  <div class="panel-body">

    <!-- Sticky Header -->
    <header class="sticky-header">
      <div class="sticky-left">
        ${this.icons.repoForked}
        <span class="sticky-repo">${profileShort}</span>
        <span class="sticky-branch">${modelShort}</span>
      </div>
      <button class="sticky-rerun" onclick="vscode.postMessage({type:'runReview'})">
        ${this.icons.refreshCw} Re-run
      </button>
    </header>

    <!-- Stats Bar -->
    <div class="hero-bar">
      <div class="hero-stat">
        <span class="hero-stat-val" style="color:var(--sev-error)">${errorCount}</span>
        <span class="hero-stat-label">Errors</span>
      </div>
      <div class="hero-stat">
        <span class="hero-stat-val" style="color:var(--fg-muted)">${warnCount}</span>
        <span class="hero-stat-label">Warnings</span>
      </div>
      <div class="hero-stat">
        <span class="hero-stat-val" style="color:var(--fg-default)">${filesCount}</span>
        <span class="hero-stat-label">Files</span>
      </div>
    </div>

    <!-- Sources banner (multi-repo) -->
    ${this.renderSourcesBanner(r.sources || [])}

    ${r.comments.length > 0 ? `
    <!-- Filter Pills -->
    <div class="filter-pills-row">
      <button class="filter-pill fp-active-all" data-filter="all" data-cls="fp-active-all">
        All <span class="pill-count">${r.comments.length}</span>
      </button>
      <button class="filter-pill" data-filter="error" data-cls="fp-active-error">
        ${this.icons.xCircle} Error <span class="pill-count">${errorCount}</span>
      </button>
      <button class="filter-pill" data-filter="warning" data-cls="fp-active-warning">
        ${this.icons.alertTriangle} Warning <span class="pill-count">${warnCount}</span>
      </button>
      <button class="filter-pill" data-filter="note" data-cls="fp-active-note">
        ${this.icons.info} Info <span class="pill-count">${infoCount}</span>
      </button>
    </div>
    <!-- Review Cards -->
    <div class="review-cards-list" id="reviewCardsList">
      ${commentsHtml}
      <div class="filter-empty" id="filterEmpty" hidden>No issues match this filter.</div>
    </div>
    ` : `
    <!-- Empty State -->
    <div class="empty-state">
      <div class="empty-state-circle">${this.icons.checkCircle}</div>
      <div class="empty-state-title">No issues found</div>
      <div class="empty-state-sub">All code meets quality standards</div>
    </div>
    `}

    <!-- Tests -->
    ${this.renderTestsHtml(r.tests)}

    <!-- Commit Messages (local reviews only) -->
    ${this.renderCommitMessagesHtml(r.commitMessages ?? [])}

  </div>

  <!-- Bottom Toolbar -->
  <div class="bottom-bar">
    <div class="toolbar">
      <button class="toolbar-btn" onclick="vscode.postMessage({type:'goHome'})">
        ${this.icons.home}<span>Home</span>
      </button>
      <button class="toolbar-btn" onclick="vscode.postMessage({type:'selectProfile'})">
        ${this.icons.settings}<span>Profile</span>
      </button>
      <button class="toolbar-btn" onclick="vscode.postMessage({type:'copyMarkdown'})">
        ${this.icons.copyClipboard}<span>Copy MD</span>
      </button>
    </div>
    <div class="meta-footer">${this.escapeHtml(r.backendUsed)} &middot; ${(r.durationMs / 1000).toFixed(1)}s</div>
      </div>

<script>
  const vscode = acquireVsCodeApi();
  function openFile(file, line) { vscode.postMessage({type:'openFile', file, line}); }
  function toggleFix(id, btn) {
    const body = document.getElementById(id);
    if (!body) return;
    const isHidden = body.hasAttribute('hidden');
    if (isHidden) { body.removeAttribute('hidden'); btn.classList.add('expanded'); }
    else          { body.setAttribute('hidden', ''); btn.classList.remove('expanded'); }
  }
  (function setupFilters() {
    const pills = Array.from(document.querySelectorAll('.filter-pill'));
    if (pills.length === 0) return;
    const cards = Array.from(document.querySelectorAll('.review-card'));
    const empty = document.getElementById('filterEmpty');
    const ALL_ACTIVE = ['fp-active-all','fp-active-error','fp-active-warning','fp-active-note'];
    function apply() {
      const active = pills.find(p => ALL_ACTIVE.some(c => p.classList.contains(c)));
      const filter = active ? active.getAttribute('data-filter') : 'all';
      let visible = 0;
      cards.forEach(card => {
        const sev = card.getAttribute('data-sev') || 'note';
        const show = filter === 'all' || sev === filter;
        card.classList.toggle('is-hidden', !show);
        if (show) visible++;
      });
      if (empty) empty.toggleAttribute('hidden', visible !== 0);
    }
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => ALL_ACTIVE.forEach(c => p.classList.remove(c)));
        const cls = pill.getAttribute('data-cls') || 'fp-active-all';
        pill.classList.add(cls);
        apply();
      });
    });
    apply();
  })();
</script>
</body>
</html>`;
  }

  private renderSourcesBanner(sources: ReviewSource[]): string {
    if (!sources || sources.length === 0) { return ''; }
    const chips = sources.map(s => {
      const label = `${s.type === 'gitlab' ? 'MR' : 'PR'} #${s.mrNumber} — ${this.escapeHtml(s.repo)}`;
      return `<span class="source-chip">${this.icons.repoForked}${label}</span>`;
    }).join('');
    return `
      <div class="sources-banner">
        <div class="sources-banner-label">Reviewing ${sources.length} repositories</div>
        <div>${chips}</div>
      </div>`;
  }

  private renderTestsHtml(tests: ReviewTest[]): string {
    if (!tests || tests.length === 0) { return ''; }

    const categoryMeta: Record<string, { label: string; color: string; bg: string }> = {
      functional:  { label: 'Functional',  color: '#3fb950', bg: 'rgba(63,185,80,0.10)' },
      security:    { label: 'Security',    color: '#f85149', bg: 'rgba(248,81,73,0.10)' },
      boundary:    { label: 'Boundary',    color: '#d29922', bg: 'rgba(210,153,34,0.10)' },
      performance: { label: 'Performance', color: '#58a6ff', bg: 'rgba(88,166,255,0.10)' },
    };

    const testItems = tests.map((t, idx) => {
      const steps = t.steps.map((s, i) => `<li style="font-size:11px;color:var(--fg-default);line-height:1.6">${this.escapeHtml(s)}</li>`).join('');
      const cat = categoryMeta[t.category] || categoryMeta.functional;
      const catTag = `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:600;letter-spacing:0.04em;background:${cat.bg};color:${cat.color};border:1px solid ${cat.color}22;margin-left:6px;vertical-align:middle">${cat.label.toUpperCase()}</span>`;
      return `
        <div style="margin-bottom:${idx < tests.length - 1 ? '10px' : '0'}">
          <div style="font-size:10px;font-weight:600;color:var(--fg-muted);margin-bottom:4px;letter-spacing:0.05em;display:flex;align-items:center;flex-wrap:wrap;gap:4px">
            <span style="text-transform:uppercase">${this.escapeHtml(t.title)}</span>${catTag}
          </div>
          <ol style="margin:0;padding-left:16px">${steps}</ol>
        </div>`;
    }).join('');

    const testId = 'tests-body';
    return `
      <div style="margin:10px 10px 10px;background:var(--bg-overlay);border:1px solid var(--border-default);border-radius:8px;overflow:hidden">
        <button onclick="toggleFix('${testId}',this)" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:transparent;border:none;cursor:pointer;font-family:var(--font-sans)">
          <div style="display:flex;align-items:center;gap:6px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
            <span style="font-size:11px;font-weight:600;color:var(--accent-fg)">Integration Tests</span>
            <span style="font-size:10px;color:var(--fg-subtle);font-weight:400">${tests.length}</span>
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.15s"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div id="${testId}" hidden style="border-top:1px solid var(--border-default);padding:10px 12px">${testItems}</div>
      </div>`;
  }

  private renderCommitMessagesHtml(messages: string[]): string {
    if (!messages || messages.length === 0) { return ''; }

    const msgItems = messages.map((msg, idx) => {
      const escaped = this.escapeHtml(msg);
      const copyId  = `commit-copy-${idx}`;
      return `
        <div style="margin-bottom:${idx < messages.length - 1 ? '8px' : '0'};position:relative">
          <div style="font-family:var(--font-mono,'Menlo','Consolas',monospace);font-size:11px;color:var(--fg-default);background:var(--bg-subtle);border:1px solid var(--border-default);border-radius:5px;padding:7px 36px 7px 10px;line-height:1.5;word-break:break-word">${escaped}</div>
          <button id="${copyId}"
            onclick="(function(btn,text){navigator.clipboard.writeText(text).then(function(){var orig=btn.innerHTML;btn.innerHTML='✓';setTimeout(function(){btn.innerHTML=orig;},1200);});})(this,${JSON.stringify(msg)})"
            title="Copy to clipboard"
            style="position:absolute;top:5px;right:6px;padding:2px 5px;font-size:10px;background:var(--bg-muted);border:1px solid var(--border-default);border-radius:4px;cursor:pointer;color:var(--fg-muted);font-family:var(--font-sans)">
            Copy
          </button>
        </div>`;
    }).join('');

    const bodyId = 'commit-msgs-body';
    return `
      <div style="margin:10px 10px 10px;background:var(--bg-overlay);border:1px solid var(--border-default);border-radius:8px;overflow:hidden">
        <button onclick="toggleFix('${bodyId}',this)" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:transparent;border:none;cursor:pointer;font-family:var(--font-sans)">
          <div style="display:flex;align-items:center;gap:6px">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>
            <span style="font-size:11px;font-weight:600;color:var(--accent-fg)">Suggested Commit Messages</span>
            <span style="font-size:10px;color:var(--fg-subtle);font-weight:400">${messages.length}</span>
          </div>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-subtle)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transition:transform 0.15s"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div id="${bodyId}" hidden style="border-top:1px solid var(--border-default);padding:10px 12px">${msgItems}</div>
      </div>`;
  }

  private escapeHtml(str: string): string {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return str.replace(/[&<>"']/g, (match) => map[match as keyof typeof map]);
  }

  private escapeJs(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  /** Extract the first sentence from a message for concise display.
   *  Splits on '. ', '! ', '? ' or a trailing punctuation at end of string. */
  private firstSentence(msg: string): string {
    const trimmed = msg.trim();
    // Match end of first sentence: period/!/? followed by space+capital or end of string
    const m = trimmed.match(/^(.*?[.!?])(?:\s+[A-Z]|$)/s);
    if (m && m[1].length >= 10) {
      return m[1].trim();
    }
    // Fallback: truncate at 120 chars on a word boundary
    if (trimmed.length <= 120) { return trimmed; }
    const cut = trimmed.lastIndexOf(' ', 120);
    return cut > 60 ? trimmed.slice(0, cut) + '…' : trimmed.slice(0, 120) + '…';
  }

  /** Convert backtick spans in already-HTML-escaped text to <code> elements.
   *  Input must already be HTML-escaped so we only need to handle `` ` ``. */
  private renderInlineCode(escaped: string): string {
    // Replace `...` with <code class="inline-code">...</code>
    // The content between backticks is already escaped, so safe to wrap directly.
    return escaped.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  }

  private async resolveWorkspaceFileUri(filePath: string): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }

    // Normalise path separators (Windows diffs can have backslashes)
    const normalized = filePath.replace(/\\/g, '/');

    // Strategy: try progressively shorter suffix segments against every workspace
    // root using direct stat() calls only — no findFiles(), no rg spawned, no
    // workspace scan.
    //
    // Example: AI returns "drivers/sample/src/sample_bus.c"
    //   attempt 0 → stat(root/drivers/sample/src/sample_bus.c)
    //   attempt 1 → stat(root/sample/src/sample_bus.c)
    //   attempt 2 → stat(root/src/sample_bus.c)
    //   attempt 3 → stat(root/sample_bus.c)
    //
    // Each stat() is a single kernel call that returns in microseconds.
    // Total attempts = path_depth × workspace_folders — always tiny.
    //
    // If nothing matches we return undefined and renderCodeLine shows
    // "Source file not found in workspace." — already handled gracefully.
    const segments = normalized.split('/');

    for (let start = 0; start < segments.length; start++) {
      const suffix = segments.slice(start).join('/');
      for (const folder of folders) {
        const candidate = vscode.Uri.joinPath(folder.uri, suffix);
        try {
          await vscode.workspace.fs.stat(candidate);
          return candidate;
        } catch {
          // not at this path, try next
        }
      }
    }

    // Genuinely not found locally — show "Source unavailable" in the panel.
    // Never fall back to findFiles() which would spawn rg against the workspace.
    return undefined;
  }

  private async getFileLines(filePath: string): Promise<string[] | undefined> {
    // The timeout wraps the ENTIRE operation — including resolveWorkspaceFileUri()
    // which can call findFiles() internally (no internal timeout, full workspace scan).
    // Without this outer guard, a single unresolvable file path blocks the panel render.
    const work = async (): Promise<string[] | undefined> => {
      const fileUri = await this.resolveWorkspaceFileUri(filePath);
      if (!fileUri) { return undefined; }
      const content = await vscode.workspace.fs.readFile(fileUri);
      const text = new TextDecoder('utf-8').decode(content);
      return text.replace(/\r\n/g, '\n').split('\n');
    };

    // Resolves to undefined on timeout (not rejects) so the catch is only for
    // genuine errors — undefined is already handled by renderCodeLine as
    // "Source file not found in workspace."
    const timeoutGuard = new Promise<undefined>(resolve =>
      setTimeout(() => resolve(undefined), 3000)
    );

    try {
      return await Promise.race([work(), timeoutGuard]);
    } catch (e) {
      console.error(`Error reading file snippet: ${e}`);
      return undefined;
    }
  }

  /**
   * Lightweight multi-language syntax highlighter.
   * Covers: keywords, types, preprocessor directives, string/char literals,
   * line & block comments, numbers, and operators — good enough for C/C++,
   * TypeScript, Python, and most embedded-systems languages.
   */
  private highlightCode(raw: string): string {
    // 1. Escape HTML first so we can inject <span> safely
    const esc = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    type Token = { type: string; value: string };
    const tokens: Token[] = [];
    let i = 0;

    // C/C++/embedded keywords
    const KEYWORDS = new Set([
      'auto','break','case','char','const','continue','default','do','double',
      'else','enum','extern','float','for','goto','if','inline','int','long',
      'register','restrict','return','short','signed','sizeof','static','struct',
      'switch','typedef','union','unsigned','void','volatile','while',
      // C++
      'bool','catch','class','constexpr','delete','explicit','export','false',
      'friend','mutable','namespace','new','noexcept','nullptr','operator',
      'override','private','protected','public','template','this','throw','true',
      'try','typename','using','virtual',
      // TypeScript / JS
      'async','await','const','debugger','declare','extends','finally',
      'from','function','implements','import','in','instanceof','interface','let',
      'module','of','package','super','type','typeof','var','yield',
      // Python
      'and','as','assert','def','del','elif','except','exec','global','lambda',
      'not','or','pass','print','raise','with',
    ]);

    while (i < raw.length) {
      // Block comment  /* … */
      if (raw[i] === '/' && raw[i+1] === '*') {
        const end = raw.indexOf('*/', i + 2);
        const val = end === -1 ? raw.slice(i) : raw.slice(i, end + 2);
        tokens.push({ type: 'comment', value: val });
        i += val.length;
        continue;
      }
      // Line comment  // …  or  # …
      if ((raw[i] === '/' && raw[i+1] === '/') || raw[i] === '#') {
        tokens.push({ type: 'comment', value: raw.slice(i) });
        break;
      }
      // String  " … "  (with escape handling)
      if (raw[i] === '"' || raw[i] === '`') {
        const q = raw[i];
        let j = i + 1;
        while (j < raw.length && !(raw[j] === q && raw[j-1] !== '\\')) { j++; }
        tokens.push({ type: 'string', value: raw.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
      // Single-quoted string/char  ' … '
      if (raw[i] === "'") {
        let j = i + 1;
        while (j < raw.length && !(raw[j] === "'" && raw[j-1] !== '\\')) { j++; }
        tokens.push({ type: 'string', value: raw.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
      // Number literal  (hex, float, int, binary)
      if (/[0-9]/.test(raw[i]) || (raw[i] === '.' && /[0-9]/.test(raw[i+1] ?? ''))) {
        let j = i;
        if (raw[i] === '0' && (raw[i+1] === 'x' || raw[i+1] === 'X')) {
          j += 2; while (j < raw.length && /[0-9a-fA-F_]/.test(raw[j])) { j++; }
        } else if (raw[i] === '0' && (raw[i+1] === 'b' || raw[i+1] === 'B')) {
          j += 2; while (j < raw.length && /[01_]/.test(raw[j])) { j++; }
        } else {
          while (j < raw.length && /[0-9._eEfFuUlL]/.test(raw[j])) { j++; }
        }
        tokens.push({ type: 'number', value: raw.slice(i, j) });
        i = j;
        continue;
      }
      // Identifier or keyword
      if (/[a-zA-Z_$]/.test(raw[i])) {
        let j = i;
        while (j < raw.length && /[a-zA-Z0-9_$]/.test(raw[j])) { j++; }
        const word = raw.slice(i, j);
        tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word });
        i = j;
        continue;
      }
      // Operator / punctuation
      if (/[+\-*/%=<>!&|^~?:;,.()\[\]{}]/.test(raw[i])) {
        tokens.push({ type: 'op', value: raw[i] });
        i++;
        continue;
      }
      // Whitespace
      tokens.push({ type: 'ws', value: raw[i] });
      i++;
    }

    // Map token types to CSS classes
    return tokens.map(t => {
      const v = esc(t.value);
      switch (t.type) {
        case 'keyword':  return `<span class="tok-kw">${v}</span>`;
        case 'string':   return `<span class="tok-str">${v}</span>`;
        case 'number':   return `<span class="tok-num">${v}</span>`;
        case 'comment':  return `<span class="tok-cmt">${v}</span>`;
        case 'op':       return `<span class="tok-op">${v}</span>`;
        default:         return v;
      }
    }).join('');
  }

  private renderCodeLine(
    fileLines: string[] | undefined,
    startLine: number,
    endLine: number | undefined,
    codeFragment?: string,
  ): string {
    if (!fileLines || fileLines.length === 0) {
      return `<div class="card-code-unavailable">Source file not found in workspace.</div>`;
    }

    const total = fileLines.length;

    // Normalise: AI sometimes returns 0-based line numbers
    let flagFirst = startLine <= 0 ? 1 : Math.min(startLine, total);
    let flagLast  = (endLine !== undefined && endLine > 0)
      ? Math.min(total, Math.max(flagFirst, endLine))
      : flagFirst;

    // If the AI provided a verbatim code fragment, search for it within a
    // ±10-line window around the AI-reported line to find the true position.
    // This corrects cases where the AI's line number is off by a few lines.
    if (codeFragment) {
      const fragFirstLine = codeFragment.split('\n')[0].replace(/^[+\- ]/, '').trim();
      const fragLineCount = codeFragment.split('\n').length;
      const MIN_FRAG_LEN = 8;
      if (fragFirstLine.length >= MIN_FRAG_LEN) {
        const searchStart = Math.max(1, flagFirst - 50);
        const searchEnd   = Math.min(total, flagFirst + 50);
        for (let ln = searchStart; ln <= searchEnd; ln++) {
          if ((fileLines[ln - 1] ?? '').trim().includes(fragFirstLine)) {
            flagFirst = ln;
            flagLast  = Math.min(total, ln + fragLineCount - 1);
            break;
          }
        }
      }
    }

    // If the flagged range is all blank, scan ±5 for nearest non-empty line
    const rangeBlank = (a: number, b: number) => {
      for (let ln = a; ln <= b; ln++) {
        if ((fileLines[ln - 1] ?? '').trim() !== '') { return false; }
      }
      return true;
    };

    if (rangeBlank(flagFirst, flagLast)) {
      let found = -1;
      for (let delta = 1; delta <= 5 && found === -1; delta++) {
        for (const c of [flagFirst - delta, flagLast + delta]) {
          if (c >= 1 && c <= total && (fileLines[c - 1] ?? '').trim() !== '') {
            found = c; break;
          }
        }
      }
      if (found !== -1) {
        flagFirst = flagLast = found;
      } else {
        return `<div class="card-code-unavailable">Line ${startLine} is empty in source.</div>`;
      }
    }

    // Show ±2 context lines around the flagged range
    const CONTEXT = 2;
    const viewFirst = Math.max(1, flagFirst - CONTEXT);
    const viewLast  = Math.min(total, flagLast  + CONTEXT);

    const rows = [];
    for (let ln = viewFirst; ln <= viewLast; ln++) {
      const raw        = (fileLines[ln - 1] ?? '').replace(/\t/g, '  ');
      const html       = this.highlightCode(raw);
      const isFlagged  = ln >= flagFirst && ln <= flagLast;
      const rowClass   = isFlagged ? 'card-code-row card-code-row-flagged' : 'card-code-row card-code-row-ctx';
      rows.push(
        `<div class="${rowClass}">` +
          `<span class="card-code-ln${isFlagged ? ' card-code-ln-flagged' : ''}">${ln}</span>` +
          `<span class="card-code-text">${html || '&nbsp;'}</span>` +
        `</div>`
      );
    }

    return `<div class="card-code-block">${rows.join('')}</div>`;
  }

  /**
   * Renders a code block from diff-sourced context stored on a remote comment.
   * Identical visual structure to renderCodeLine — same CSS classes, same
   * syntax highlighter — but sourced from the pre-extracted string rather than
   * a local file, so it works for remote MR reviews with no local workspace.
   *
   * @param codeContext  Newline-joined lines extracted from the diff (+/ prefix already stripped)
   * @param contextStartLine  1-based line number of the first line in codeContext
   * @param flagFirst    First flagged line (1-based)
   * @param flagLast     Last flagged line (1-based), or undefined if single-line
   */
  private renderDiffContext(
    codeContext: string,
    contextStartLine: number,
    flagFirst: number,
    flagLast: number | undefined,
    codeFragment?: string,
  ): string {
    const lines = codeContext.split('\n');
    let fFirst = flagFirst;
    let fLast  = (flagLast !== undefined && flagLast >= flagFirst) ? flagLast : flagFirst;

    // If the AI provided a verbatim code fragment, locate it within the
    // extracted context window and use that position for the highlight instead
    // of the AI's (sometimes inaccurate) line number.
    if (codeFragment) {
      const fragFirstLine = codeFragment.split('\n')[0].replace(/^[+\- ]/, '').trim();
      const fragLineCount = codeFragment.split('\n').length;
      const MIN_FRAG_LEN = 8;
      if (fragFirstLine.length >= MIN_FRAG_LEN) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().includes(fragFirstLine)) {
            fFirst = contextStartLine + i;
            fLast  = fFirst + fragLineCount - 1;
            break;
          }
        }
      }
    }

    const rows = lines.map((raw, i) => {
      const ln        = contextStartLine + i;
      const html      = this.highlightCode(raw.replace(/\t/g, '  '));
      const isFlagged = ln >= fFirst && ln <= fLast;
      const rowClass  = isFlagged ? 'card-code-row card-code-row-flagged' : 'card-code-row card-code-row-ctx';
      return (
        `<div class="${rowClass}">` +
          `<span class="card-code-ln${isFlagged ? ' card-code-ln-flagged' : ''}">${ln}</span>` +
          `<span class="card-code-text">${html || '&nbsp;'}</span>` +
        `</div>`
      );
    });

    return `<div class="card-code-block">${rows.join('')}</div>`;
  }
}
