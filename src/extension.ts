// src/extension.ts
// VS Code extension entry point

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import { RuleLoader, ReviewProfile } from './ruleLoader';
import { runReview, autoDetectProfile, ReviewSource } from './reviewer';
import { AIKeys } from './aiBackend';
import { ReviewPanelProvider } from './panelProvider';
import { normalizeGitLabDiffResponse } from './diffFilter';

const execAsync = promisify(exec);

let ruleLoader: RuleLoader | undefined;
let panelProvider: ReviewPanelProvider;
let extensionContext: vscode.ExtensionContext;

/** In-memory requirements — never written to YAML on disk. */
let activeRequirements: { profileId: string; text: string } | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('Revvy activated');
  extensionContext = context;

  // ── STEP 1: Register the webview provider IMMEDIATELY ─────────────────────
  // This MUST happen before any async/throwing work so VS Code can resolve
  // the sidebar panel. If the provider is never registered, the panel shows
  // an infinite spinner because no resolver ever responds.
  panelProvider = new ReviewPanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('revvy.mainPanel', panelProvider)
  );

  // ── STEP 2: Register all commands ────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.reviewDiff', async () => {
      await reviewDiff();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.reviewFile', async () => {
      await reviewActiveFile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.selectProfile', async () => {
      await selectProfile();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.openRulesFolder', async () => {
      try {
        const rulesPath = getRulesPath();
        await vscode.env.openExternal(vscode.Uri.file(rulesPath));
      } catch (e: any) {
        vscode.window.showErrorMessage(e.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.setTicketRequirements', async () => {
      await setTicketRequirements();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.clearTicketRequirements', async () => {
      await clearTicketRequirements();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.reloadRules', async () => {
      const loader = await ensureRuleLoader();
      if (!loader) { return; }
      const profiles = await loader.loadAll();
      vscode.window.showInformationMessage(`Reloaded ${profiles.length} profiles`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.checkProfiles', async () => {
      await checkProfiles();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.reviewMultiMR', async () => {
      await reviewMultiMR();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.setOpenAIKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your OpenAI API key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-...',
      });
      if (key !== undefined) {
        await context.secrets.store('revvy.openaiApiKey', key);
        vscode.window.showInformationMessage('OpenAI API key saved securely.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.setAnthropicKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-ant-...',
      });
      if (key !== undefined) {
        await context.secrets.store('revvy.anthropicApiKey', key);
        vscode.window.showInformationMessage('Anthropic API key saved securely.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('revvy.goHome', () => {
      const label = activeRequirements ? buildRequirementsLabel(activeRequirements.text) : '';
      panelProvider.showWelcome(!!activeRequirements, label);
    })
  );

  // Rules are loaded lazily on first command/panel use via ensureRuleLoader().
  // No eager disk I/O or file watchers at activation time — keeps startup cost zero.
}

// ────────────────────────────────────────────────────────────────────────────
// Lazy rule-loader initialiser (called by every command that needs rules)
// ────────────────────────────────────────────────────────────────────────────

async function ensureRuleLoader(): Promise<RuleLoader | undefined> {
  if (ruleLoader) { return ruleLoader; }

  try {
    const rulesPath = getRulesPath();
    ruleLoader = new RuleLoader(rulesPath, msg => console.log('[RuleLoader]', msg));
    await ruleLoader.loadAll();
    // One-time migration: strip any ticket_context persisted by older extension versions.
    // Requirements are now session-only (in-memory); on-disk ticket_context is legacy.
    for (const p of ruleLoader.getAllProfiles()) {
      const yamlPath = path.join(rulesPath, `${p.id}.yaml`);
      try {
        const content = fs.readFileSync(yamlPath, 'utf8');
        const data = yaml.load(content) as any;
        if (data?.profile?.ticket_context) {
          delete data.profile.ticket_context;
          fs.writeFileSync(yamlPath, yaml.dump(data));
        }
      } catch { /* ignore files we can't touch */ }
    }
    // Start the YAML watcher now that the loader is initialised.
    // We only do this once (guarded by the `if (ruleLoader)` check above).
    extensionContext.subscriptions.push(
      ruleLoader.watchForChanges(async () => {
        await ruleLoader!.loadAll();
        vscode.window.showInformationMessage('Rules reloaded from YAML');
      })
    );
    return ruleLoader;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Revvy: ${err.message}`);
    return undefined;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function getRulesPath(): string {
  const config = vscode.workspace.getConfiguration('revvy');
  const relativePath = config.get<string>('rulesPath', '.vscode-reviewer/profiles');
  
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder open');
  }
  
  return path.join(folders[0].uri.fsPath, relativePath);
}

function getActiveProfile(): ReviewProfile {
  if (!ruleLoader) {
    throw new Error('No workspace folder open — open a folder to load review profiles.');
  }
  const config = vscode.workspace.getConfiguration('revvy');
  const activeId = config.get<string>('activeProfile', 'c-embedded');
  const profile = ruleLoader.getProfile(activeId);

  if (!profile) {
    const all = ruleLoader.getAllProfiles();
    if (all.length === 0) {
      throw new Error('No review profiles found. Check that .vscode-reviewer/profiles/ contains valid YAML files.');
    }
    const availableIds = all.map(p => `"${p.id}"`).join(', ');
    throw new Error(
      `Active profile "${activeId}" not found. Available profiles: ${availableIds}. ` +
      `Run "Revvy: Switch Review Profile" to select a valid profile.`
    );
  }

  return profile;
}

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('No workspace folder open');
  }
  return folders[0].uri.fsPath;
}

async function getSecrets(): Promise<AIKeys> {
  const [openai, anthropic] = await Promise.all([
    extensionContext.secrets.get('revvy.openaiApiKey'),
    extensionContext.secrets.get('revvy.anthropicApiKey'),
  ]);
  return { openai, anthropic };
}

/**
 * Builds a short display label for the active requirements badge.
 * Uses the first line (e.g. "PROJ-123" or "Jira Ticket: PROJ-123"),
 * falling back to a truncated excerpt of the full text.
 */
function buildRequirementsLabel(text: string): string {
  const firstLine = text.split('\n')[0].trim();
  const MAX = 35;
  if (firstLine.length <= MAX) { return firstLine; }
  return firstLine.slice(0, MAX - 1) + '\u2026'; // …
}

// Async git diff — runs staged and unstaged in parallel to avoid blocking the
// extension host event loop (replaces the old execSync approach).
async function getGitDiff(cwd: string, baseBranch?: string): Promise<string> {
  try {
    const base = baseBranch || 'HEAD';
    const [stagedResult, unstagedResult] = await Promise.all([
      execAsync(`git diff --cached ${base}`, { cwd, encoding: 'utf8' }),
      execAsync(`git diff ${base}`,          { cwd, encoding: 'utf8' }),
    ]);
    return ((stagedResult.stdout ?? '') + (unstagedResult.stdout ?? '')).trim();
  } catch (error: any) {
    const firstLine = (error.message as string).split('\n')[0].trim();
    throw new Error(`Git diff failed: ${firstLine}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Commands
// ────────────────────────────────────────────────────────────────────────────

async function reviewDiff() {
  const loader = await ensureRuleLoader();
  if (!loader) { return; }

  let profile: ReviewProfile;
  try {
    profile = getActiveProfile();
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
    return;
  }

  const mode = await vscode.window.showQuickPick(
    ['Compare against HEAD (current changes)', 'Choose a base branch...'],
    { title: `Review with: ${profile.label}` }
  );

  if (!mode) return;

  let cwd: string;
  try {
    cwd = getWorkspaceRoot();
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
    return;
  }

  let baseBranch: string | undefined;
  if (mode.includes('Choose')) {
    try {
      const branches = execSync('git branch -a --format=%(refname:short)', { cwd, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      baseBranch = await vscode.window.showQuickPick(branches, {
        placeHolder: 'Select base branch',
      });
      if (!baseBranch) return;
    } catch {
      vscode.window.showErrorMessage('Failed to list git branches');
      return;
    }
  }

  await runReviewWithProgress(profile, () => getGitDiff(cwd, baseBranch), await getSecrets());
}

async function reviewActiveFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active file to review');
    return;
  }

  const loader = await ensureRuleLoader();
  if (!loader) { return; }

  const filePath = editor.document.uri.fsPath;
  const fileName = path.basename(filePath);
  const cwd = path.dirname(filePath);

  // Use the explicitly selected profile — no auto-detect override.
  // The user chose a profile; respect that choice regardless of file extension.
  let profile: ReviewProfile;
  try {
    profile = getActiveProfile();
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
    return;
  }

  await runReviewWithProgress(profile, async () => {
    try {
      const result = await execAsync(`git diff HEAD -- "${fileName}"`, { cwd, encoding: 'utf8' });
      return result.stdout ?? '';
    } catch {
      // Not in git, return full file
      return editor.document.getText();
    }
  }, await getSecrets());
}

async function runReviewWithProgress(
  profile: ReviewProfile,
  getDiff: () => Promise<string> | string,
  keys: AIKeys = {}
) {
  // Inject in-memory requirements if they belong to this profile.
  const profileWithReqs: ReviewProfile =
    (activeRequirements && activeRequirements.profileId === profile.id)
      ? { ...profile, ticket_context: { raw_requirements: activeRequirements.text } }
      : profile;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `AI Review: ${profile.label}`,
      cancellable: false,
    },
    async progress => {
      // Step 1: Fetch diff
      progress.report({ message: 'Fetching diff…' });
      panelProvider.showLoading();
      panelProvider.updateLoading('Fetching diff…', 0.1);

      let diff: string;
      try {
        diff = await Promise.resolve(getDiff());
      } catch (error: any) {
        panelProvider.showLoadingError(error.message);
        return;
      }

      if (!diff.trim()) {
        panelProvider.showNoChanges();
        return;
      }

      // Step 2: Load rules / prepare prompt
      progress.report({ message: 'Loading rules…' });
      panelProvider.updateLoading('Loading rules…', 0.25);
      await new Promise(r => setTimeout(r, 80)); // allow webview to paint

      // Step 3: Send to AI — phase transition uses updateLoading (full HTML rebuild),
      // then all high-frequency token updates use patchLoading (postMessage only).
      progress.report({ message: 'Analyzing with AI…' });
      panelProvider.updateLoading('Analyzing changes…', 0.5);

      // Count the number of reviewable files so the counter can show "2/4 files"
      const fileLinesCount = (diff.match(/^diff --git /gm) || []).length;
      const filesTotal = Math.max(1, fileLinesCount);

      try {
        let tokenCount = 0;
        let filesDone  = 0;
        let lastReportedToken = 0;

        const onChunk = (chunk: string) => {
          tokenCount += chunk.length;
          if (tokenCount - lastReportedToken >= 40) {
            lastReportedToken = tokenCount;
            const approxTokens = Math.round(tokenCount / 4);
            const label = `Generating report…`;
            progress.report({ message: `${label} (~${approxTokens} tokens)` });
            panelProvider.patchLoading(label, approxTokens, filesTotal, filesDone);
          }
        };

        const result = await runReview(diff, profileWithReqs, undefined, keys, onChunk);

        if (result.filterStats && result.filterStats.skippedFiles > 0) {
          console.log(
            `[Revvy] Skipped: ${result.filterStats.skippedFilePaths.join(', ')}. ` +
            `~${result.filterStats.estimatedTokensSaved} tokens saved.`
          );
        }
        if (result.estimatedInputTokens || result.estimatedOutputTokens) {
          console.log(
            `[Revvy] Estimated tokens — input: ~${result.estimatedInputTokens}, ` +
            `output: ~${result.estimatedOutputTokens}, ` +
            `duration: ${result.durationMs}ms`
          );
        }

        panelProvider.updateLoading('Done!', 1.0);
        await new Promise(r => setTimeout(r, 120));
        await panelProvider.showResult(result);
      } catch (error: any) {
        const msg = error.message || 'Unknown error';
        console.error('[Revvy] Review failed:', error);
        panelProvider.showLoadingError(msg);
        vscode.window.showErrorMessage(`Review failed: ${msg}`);
      }
    }
  );
}

async function selectProfile() {
  const loader = await ensureRuleLoader();
  if (!loader) { return; }

  const profiles = loader.getAllProfiles();
  
  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No profiles loaded. Check your YAML files.');
    return;
  }

  const items = profiles.map(p => ({
    label: p.label,
    description: p.description,
    detail: `${p.rules.filter(r => r.enabled).length} active rules`,
    id: p.id,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Select Review Profile',
  });

  if (selected) {
    // Persist at both Global and Workspace levels so the setting survives
    // even when no .vscode/settings.json exists (workspace-level writes are
    // silently dropped in that case, causing fallback to the hardcoded default).
    const selectedId = (selected as any).id;
    await vscode.workspace
      .getConfiguration('revvy')
      .update('activeProfile', selectedId, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration('revvy')
      .update('activeProfile', selectedId, vscode.ConfigurationTarget.Workspace);

    vscode.window.showInformationMessage(`Active profile: ${selected.label}`);

    // Refresh home panel so the profile name and requirements badge stay current.
    const label = activeRequirements ? buildRequirementsLabel(activeRequirements.text) : '';
    panelProvider.showWelcome(!!activeRequirements, label);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Check Profile Files — validates every YAML file and shows a detailed report
// ────────────────────────────────────────────────────────────────────────────

async function checkProfiles() {
  const loader = await ensureRuleLoader();
  if (!loader) { return; }

  const rulesPath = getRulesPath();
  const files = fs.readdirSync(rulesPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (files.length === 0) {
    vscode.window.showWarningMessage(`No YAML files found in ${rulesPath}`);
    return;
  }

  const results: string[] = [];

  for (const file of files) {
    const fullPath = path.join(rulesPath, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const errors: string[] = [];

    try {
      const data = yaml.load(content) as any;

      // Check top-level structure
      if (!data) { errors.push('File is empty or parses to null'); }
      else if (!data.profile) { errors.push('Missing "profile" top-level key'); }
      else {
        const p = data.profile;

        // Check required fields
        if (!p.id) errors.push('Missing required field: id');
        if (!p.label) errors.push('Missing required field: label');
        if (!p.rules) errors.push('Missing required field: rules');
        else if (!Array.isArray(p.rules)) errors.push('"rules" must be an array');
        else if (p.rules.length === 0) errors.push('"rules" array is empty');

        // Validate each rule
        if (Array.isArray(p.rules)) {
          p.rules.forEach((r: any, i: number) => {
            if (!r.id) errors.push(`  rules[${i}]: missing "id"`);
            if (!r.severity) errors.push(`  rules[${i}]: missing "severity"`);
            else if (!['error', 'warning', 'suggestion'].includes(r.severity)) {
              errors.push(`  rules[${i}]: invalid severity "${r.severity}" (must be error|warning|suggestion)`);
            }
            if (!r.title) errors.push(`  rules[${i}]: missing "title"`);
            if (!r.description) errors.push(`  rules[${i}]: missing "description"`);
          });
        }

        // Check for duplicate rule IDs
        if (Array.isArray(p.rules) && p.rules.length > 0) {
          const ids = p.rules.map((r: any) => r.id).filter(Boolean);
          const dupes = ids.filter((id: string, idx: number) => ids.indexOf(id) !== idx);
          if (dupes.length > 0) {
            const uniqueDupes = [...new Set(dupes as string[])];
            errors.push(`  Duplicate rule IDs: ${uniqueDupes.join(', ')}`);
          }
        }

        // Check system_prompt_extra YAML syntax
        if (p.system_prompt_extra !== undefined && typeof p.system_prompt_extra !== 'string') {
          errors.push('"system_prompt_extra" must be a string');
        }

        // Check file_patterns
        if (p.file_patterns !== undefined && !Array.isArray(p.file_patterns)) {
          errors.push('"file_patterns" must be an array');
        }
      }

      if (errors.length === 0) {
        const p = (data as any).profile;
        results.push(`✅ ${file}  (id="${p.id}", ${p.rules?.length || 0} rules)`);
      } else {
        results.push(`❌ ${file}\n   ${errors.join('\n   ')}`);
      }
    } catch (parseError: any) {
      results.push(`❌ ${file}\n   YAML parse error: ${parseError.message}`);
    }
  }

  const loaded = loader.getAllProfiles();
  const failed = results.filter(r => r.startsWith('❌')).length;
  const passed = results.filter(r => r.startsWith('✅')).length;

  const summary = `✅ ${passed} passed, ❌ ${failed} failed out of ${files.length} file(s).\n\n${results.join('\n\n')}`;
  const detail = `\n\nLoaded profiles: ${loaded.map(p => `"${p.id}"`).join(', ') || '(none)'}`;

  if (failed > 0) {
    vscode.window.showWarningMessage(`Profile Check: ${summary}${detail}`);
  } else {
    vscode.window.showInformationMessage(`Profile Check: ${summary}${detail}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Multi-Repo MR/PR Review via MCP
// ────────────────────────────────────────────────────────────────────────────

interface MrRef {
  type: 'github' | 'gitlab';
  owner: string;
  repo: string;
  number: number;
  display: string;
}

/**
 * Parses any of these formats automatically:
 *
 *   Full URLs (no prefix needed):
 *     https://github.com/owner/repo/pull/123
 *     https://gitlab.com/group/sub/project/-/merge_requests/456
 *     https://mygitlab.company.com/group/project/-/merge_requests/7
 *
 *   Short refs (with explicit prefix):
 *     owner/repo#123              → GitHub
 *     github:owner/repo#123       → GitHub
 *     gitlab:group/project!456    → GitLab
 *
 *   Short refs with a default host applied by the caller:
 *     owner/repo#123  (defaultType supplied)
 *     group/project!456 (defaultType supplied)
 */
function parseMrRef(input: string, defaultType: 'github' | 'gitlab' = 'github'): MrRef | null {
  input = input.trim();

  // ── Full GitHub URL ──────────────────────────────────────────────────────
  // https://github.com/owner/repo/pull/123
  let m = input.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (m) {
    return { type: 'github', owner: m[1], repo: m[2], number: parseInt(m[3]), display: input };
  }

  // ── Full GitLab URL (cloud or self-hosted) ────────────────────────────────
  // https://gitlab.com/group/.../project/-/merge_requests/456
  // https://mygitlab.company.com/group/project/merge_requests/7  (without dash)
  m = input.match(/https?:\/\/[^/]+\/(.+?)\/-?\/merge_requests\/(\d+)/i);
  if (m) {
    const parts = m[1].split('/');
    const repo = parts.pop()!;
    const owner = parts.join('/');
    return { type: 'gitlab', owner, repo, number: parseInt(m[2]), display: input };
  }

  // ── Explicit github: prefix ───────────────────────────────────────────────
  m = input.match(/^github:([^/]+)\/([^#\s]+)#(\d+)$/i);
  if (m) {
    return { type: 'github', owner: m[1], repo: m[2], number: parseInt(m[3]), display: input };
  }

  // ── Explicit gitlab: prefix ───────────────────────────────────────────────
  m = input.match(/^gitlab:(.+)[#!](\d+)$/i);
  if (m) {
    const parts = m[1].split('/');
    const repo = parts.pop()!;
    const owner = parts.join('/');
    return { type: 'gitlab', owner, repo, number: parseInt(m[2]), display: input };
  }

  // ── Bare short ref — apply defaultType ────────────────────────────────────
  // owner/repo#123  (GitHub style)
  m = input.match(/^([^/\s]+)\/([^#!\s]+)[#!](\d+)$/);
  if (m) {
    // Use ! as a hint for GitLab even in bare mode
    const type = input.includes('!') ? 'gitlab' : defaultType;
    return { type, owner: m[1], repo: m[2], number: parseInt(m[3]), display: input };
  }

  return null;
}

/** Collects all text parts from any MCP tool result shape. */
function extractTextFromToolResult(result: any): string {
  const parts: string[] = [];
  for (const part of result?.content ?? []) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push(part.value);
    } else if (typeof part?.value === 'string') {
      parts.push(part.value);
    } else if (typeof part === 'string') {
      parts.push(part);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Fetches the diff for a single PR/MR via the appropriate MCP tool.
 * Tries multiple tool names and input key variants to handle different
 * @modelcontextprotocol/server-github and server-gitlab versions.
 */
async function fetchMrDiffViaMcp(ref: MrRef): Promise<string | null> {
  const lm = vscode.lm as any;
  if (typeof lm.invokeTool !== 'function') { return null; }

  const tools: any[] = lm.tools ?? [];
  console.log('[Revvy] MR fetch — available tools:', tools.map((t: any) => t.name));

  const cts = new vscode.CancellationTokenSource();

  if (ref.type === 'github') {
    // Prefer a diff/files tool, fall back to any pull_request tool
    const tool =
      tools.find((t: any) => { const n = (t.name ?? '').toLowerCase(); return n.includes('pull_request') && (n.includes('diff') || n.includes('file') || n.includes('content')); }) ??
      tools.find((t: any) => (t.name ?? '').toLowerCase().includes('pull_request'));

    if (!tool) { return null; }

    const inputs = [
      { owner: ref.owner, repo: ref.repo, pullNumber: ref.number },
      { owner: ref.owner, repo: ref.repo, pull_number: ref.number },
      { owner: ref.owner, repo: ref.repo, pr_number: ref.number },
    ];
    for (const input of inputs) {
      try {
        const result = await lm.invokeTool(tool.name, { input }, cts.token);
        const text = extractTextFromToolResult(result);
        if (text) { return text; }
      } catch (e: any) {
        console.log(`[Revvy] GitHub tool ${tool.name} failed (${JSON.stringify(input)}): ${e.message}`);
      }
    }
    return null;
  }

  if (ref.type === 'gitlab') {
    // Split on underscores and find the first segment that is an action verb
    // (skip server-prefix segments like "gitlab", "mcp", etc.).
    // Only the action verb determines whether the tool is read-only or mutating.
    // e.g. "gitlab_get_merge_request_diffs" → action = "get"   ✓ read
    //      "gitlab_create_merge_request"    → action = "create" ✗ mutating
    //      "get_merge_request"              → action = "get"    ✓ read
    const MUTATING_VERBS = new Set([
      'create', 'update', 'delete', 'close', 'reopen',
      'approve', 'unapprove', 'edit', 'post', 'put', 'patch',
    ]);
    const NON_VERB_PREFIXES = new Set(['gitlab', 'github', 'mcp', 'server', 'gl', 'gh']);
    const isReadMrTool = (name: string): boolean => {
      const n = name.toLowerCase();
      if (!n.includes('merge_request')) { return false; }
      const segments = n.split('_');
      // Find the first segment that looks like an action verb (not a server prefix)
      const actionVerb = segments.find(s => !NON_VERB_PREFIXES.has(s)) ?? segments[0];
      return !MUTATING_VERBS.has(actionVerb);
    };

    const tool =
      tools.find((t: any) => { const n = (t.name ?? '').toLowerCase(); return isReadMrTool(n) && (n.includes('diff') || n.includes('change')); }) ??
      tools.find((t: any) => { const n = (t.name ?? '').toLowerCase(); return isReadMrTool(n) && n.includes('get'); }) ??
      tools.find((t: any) => isReadMrTool((t.name ?? '').toLowerCase()));

    if (!tool) {
      console.log('[Revvy] No read-only GitLab merge_request tool found. Available tools:', tools.map((t: any) => t.name));
      return null;
    }

    console.log(`[Revvy] Using GitLab tool: ${tool.name}`);
    const projectPath = ref.owner ? `${ref.owner}/${ref.repo}` : ref.repo;
    const inputs = [
      { project_id: projectPath, mr_iid: ref.number },
      { project: projectPath, merge_request_iid: ref.number },
      { project_path: projectPath, iid: ref.number },
    ];
    const cts2 = new vscode.CancellationTokenSource();
    for (const input of inputs) {
      try {
        const result = await lm.invokeTool(tool.name, { input }, cts2.token);
        const text = extractTextFromToolResult(result);
        if (text) { return normalizeGitLabDiffResponse(text); }
      } catch (e: any) {
        console.log(`[Revvy] GitLab tool ${tool.name} failed (${JSON.stringify(input)}): ${e.message}`);
      }
    }
    return null;
  }

  return null;
}

async function reviewMultiMR() {
  const loader = await ensureRuleLoader();
  if (!loader) { return; }

  let profile: ReviewProfile;
  try {
    profile = getActiveProfile();
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
    return;
  }

  // ── Step 1: pick default host ─────────────────────────────────────────────
  const hostPick = await vscode.window.showQuickPick(
    [
      {
        label: '$(github) GitHub',
        description: 'Default host for bare refs like owner/repo#123',
        id: 'github' as const,
      },
      {
        label: '$(repo-forked) GitLab',
        description: 'Default host for bare refs like group/project!456',
        id: 'gitlab' as const,
      },
    ],
    {
      title: 'Multi-Repo Review — Step 1 of 2: Select default host',
      placeHolder: 'Full URLs are auto-detected regardless of this choice',
    }
  );
  if (!hostPick) { return; }
  const defaultHost = hostPick.id;

  // ── Step 2: paste URLs or short refs ─────────────────────────────────────
  const hostLabel = defaultHost === 'github' ? 'GitHub' : 'GitLab';
  const examplePR  = defaultHost === 'github'
    ? 'https://github.com/org/repo/pull/42'
    : 'https://gitlab.com/group/project/-/merge_requests/17';
  const exampleShort = defaultHost === 'github' ? 'org/repo#42' : 'group/project!17';

  const input = await vscode.window.showInputBox({
    title: `Multi-Repo Review — Step 2 of 2: Paste MR/PR links (default host: ${hostLabel})`,
    prompt: 'Paste full URLs or short refs, comma-separated. Full URLs are always auto-detected.',
    placeHolder: `${examplePR}, ${exampleShort}`,
    ignoreFocusOut: true,
  });

  if (!input?.trim()) { return; }

  const rawRefs = input.split(',').map(s => s.trim()).filter(Boolean);
  const refs: MrRef[] = [];
  const invalid: string[] = [];

  for (const raw of rawRefs) {
    const ref = parseMrRef(raw, defaultHost);
    if (ref) { refs.push(ref); } else { invalid.push(raw); }
  }

  if (invalid.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `Could not parse: ${invalid.join(', ')}. Continue with the valid refs?`,
      'Continue', 'Cancel'
    );
    if (proceed !== 'Continue') { return; }
  }

  if (refs.length === 0) {
    vscode.window.showErrorMessage('No valid MR/PR references entered.');
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Multi-repo review: fetching ${refs.length} MR/PR diff(s) via MCP…`,
      cancellable: false,
    },
    async progress => {
      // FIX 1 — fetch all MR/PR diffs in parallel instead of sequentially.
      // Previously: each ref awaited fetchMrDiffViaMcp() one-by-one.
      // Now: all fetches fire simultaneously; wall-clock cost = slowest single fetch.
      progress.report({ message: `Fetching ${refs.length} diff(s) in parallel…` });

      const fetchResults = await Promise.all(
        refs.map(async (ref) => {
          const diff = await fetchMrDiffViaMcp(ref);
          return { ref, diff };
        })
      );

      const diffs: string[]     = [];
      const sources: ReviewSource[] = [];
      const failed: string[]    = [];

      for (const { ref, diff } of fetchResults) {
        if (diff) {
          const header =
            `${'═'.repeat(60)}\n` +
            `REPO: ${ref.owner}/${ref.repo}  |  ${ref.type === 'gitlab' ? 'MR' : 'PR'} #${ref.number}\n` +
            `${'═'.repeat(60)}\n`;
          diffs.push(header + diff);
          sources.push({
            ref: ref.display,
            repo: `${ref.owner}/${ref.repo}`,
            mrNumber: ref.number,
            type: ref.type,
          });
        } else {
          failed.push(ref.display);
        }
      }

      if (failed.length > 0) {
        const hostTypes = [...new Set(refs.filter(r => failed.includes(r.display)).map(r => r.type === 'gitlab' ? 'GitLab' : 'GitHub'))];
        const msg = `Could not fetch diff via MCP for: ${failed.join(', ')}. ` +
          `Ensure the ${hostTypes.join(' / ')} MCP server is running (.vscode/mcp.json).`;
        if (diffs.length === 0) { vscode.window.showErrorMessage(msg); return; }
        vscode.window.showWarningMessage(msg);
      }

      if (diffs.length === 0) { return; }

      const combinedDiff = diffs.join('\n\n');
      const keys = await getSecrets();
      // Inject in-memory requirements for this profile (same logic as runReviewWithProgress).
      const profileWithReqs: ReviewProfile =
        (activeRequirements && activeRequirements.profileId === profile.id)
          ? { ...profile, ticket_context: { raw_requirements: activeRequirements.text } }
          : profile;
      progress.report({ message: 'Sending to AI…' });
      panelProvider.showLoading();
      panelProvider.updateLoading('Analyzing changes…', 0.5);

      try {
        let tokenCount = 0;
        let lastReportedToken = 0;
        const repoCount = sources.length;

        const onChunk = (chunk: string) => {
          tokenCount += chunk.length;
          if (tokenCount - lastReportedToken >= 40) {
            lastReportedToken = tokenCount;
            const approxTokens = Math.round(tokenCount / 4);
            const label = `Generating report…`;
            progress.report({ message: `${label} (~${approxTokens} tokens)` });
            // PERF: postMessage only — no HTML rebuild
            panelProvider.patchLoading(label, approxTokens, repoCount, 0);
          }
        };

        const result = await runReview(combinedDiff, profileWithReqs, sources, keys, onChunk);

        panelProvider.updateLoading('Done!', 1.0);
        await new Promise(r => setTimeout(r, 120));
        await panelProvider.showResult(result);
        const icon = result.verdict === 'APPROVE' ? '✅' : result.verdict === 'REQUEST_CHANGES' ? '❌' : '⚠️';
        vscode.window.showInformationMessage(
          `${icon} Multi-repo review: ${result.verdict} (${result.score}/10) — ${sources.length} repo(s)`
        );
      } catch (error: any) {
        vscode.window.showErrorMessage(`Review failed: ${error.message}`);
      }
    }
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Jira MCP helpers
// ────────────────────────────────────────────────────────────────────────────

/** Returns the Jira ticket key if `text` is exactly a Jira ID (e.g. PROJ-123), else null. */
function detectJiraId(text: string): string | null {
  const match = text.trim().match(/^([A-Z][A-Z0-9]+-\d+)$/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Invokes the `jira_get_issue` MCP tool (provided by mcp-atlassian)
 * via VS Code's Language Model Tools API (available from VS Code 1.96+).
 * Returns the ticket text on success, null when MCP is unavailable or not configured.
 * `errors` collects human-readable failure messages from all variant attempts.
 */
async function fetchJiraTicketViaMcp(ticketId: string): Promise<{ text: string | null; errors: string[] }> {
  const lm = vscode.lm as any;
  const errors: string[] = [];

  // vscode.lm.invokeTool was stabilised in VS Code 1.96
  if (typeof lm.invokeTool !== 'function') {
    console.log('[Revvy] vscode.lm.invokeTool not available (VS Code < 1.96)');
    return { text: null, errors: ['vscode.lm.invokeTool not available (VS Code < 1.96)'] };
  }

  // List all available LM tools for diagnostics
  const tools: any[] = lm.tools ?? [];
  console.log('[Revvy] Available LM tools:', tools.map((t: any) => t.name));

  // Broad match: any tool whose name contains both "jira" and "issue" (case-insensitive)
  // Covers: jira_get_issue, atlassian_jira_get_issue, mcp__atlassian__jira_get_issue, etc.
  const jiraTool = tools.find((t: any) => {
    const n: string = (t.name ?? '').toLowerCase();
    return n.includes('jira') && (n.includes('issue') || n.includes('get'));
  });

  if (!jiraTool) {
    const toolNames = tools.map((t: any) => t.name).join(', ') || '(none)';
    const msg = `No Jira tool found. Registered tools: ${toolNames}`;
    console.log(`[Revvy] ${msg}`);
    return { text: null, errors: [msg] };
  }

  console.log(`[Revvy] Using tool: ${jiraTool.name}`);

  // Try all common input key formats used by different mcp-atlassian versions
  const inputVariants = [
    { issue_key: ticketId },
    { issueKey: ticketId },
    { key: ticketId },
    { issue_id: ticketId },
    { id: ticketId },
  ];

  const cts = new vscode.CancellationTokenSource();

  for (const input of inputVariants) {
    try {
      const result = await lm.invokeTool(
        jiraTool.name,
        { input },
        cts.token
      );

      // Collect all text parts from the tool result
      const parts: string[] = [];
      for (const part of result.content ?? []) {
        if (part instanceof vscode.LanguageModelTextPart) {
          parts.push(part.value);
        } else if (typeof part?.value === 'string') {
          parts.push(part.value);
        } else if (typeof part === 'string') {
          parts.push(part);
        }
      }
      const text = parts.join('\n').trim();
      if (text) {
        return { text, errors };
      }
    } catch (err: any) {
      const msg = `Tool call failed with input ${JSON.stringify(input)}: ${err.message}`;
      console.log(`[Revvy] ${msg}`);
      errors.push(msg);
    }
  }

  return { text: null, errors };
}

// ────────────────────────────────────────────────────────────────────────────
// Ticket Requirements Management
// ────────────────────────────────────────────────────────────────────────────

async function setTicketRequirements() {
  const loader = await ensureRuleLoader();
  if (!loader) { return; }

  let profile: ReviewProfile;
  try {
    profile = getActiveProfile();
  } catch (e: any) {
    vscode.window.showErrorMessage(e.message);
    return;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'Enter a Jira ticket ID to auto-fetch (e.g. PROJ-123), or paste requirements text directly',
    placeHolder: 'PROJ-123   or   "Must use bcrypt. Must add session timeout."',
    ignoreFocusOut: true,
  });

  if (!input || !input.trim()) {
    vscode.window.showInformationMessage('No ticket requirements set — review will use rules only');
    return;
  }

  let requirementText = input.trim();

  // ── Jira auto-fetch via MCP ──────────────────────────────────────────────
  const jiraId = detectJiraId(input);
  if (jiraId) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Fetching ${jiraId} from Jira via MCP…`,
        cancellable: false,
      },
      async () => {
        const { text: fetched, errors: fetchErrors } = await fetchJiraTicketViaMcp(jiraId);
        if (fetched) {
          requirementText = `Jira Ticket: ${jiraId}\n\n${fetched}`;
          vscode.window.showInformationMessage(`✅ Fetched ${jiraId} from Jira via MCP`);
        } else {
          // MCP not available or Atlassian server not running — store the ID as a reference
          requirementText =
            `Jira Ticket ID: ${jiraId}\n` +
            `(Auto-fetch unavailable. Configure the Atlassian MCP server in .vscode/mcp.json ` +
            `and set revvy.jiraBaseUrl / revvy.jiraEmail in settings.)`;

          const errorDetail = fetchErrors.length > 0
            ? ` Errors: ${fetchErrors.slice(0, 2).join('; ')}`
            : '';
          const sel = await vscode.window.showWarningMessage(
            `Jira MCP tool not reachable. Stored "${jiraId}" as reference.${errorDetail}`,
            'Open .vscode/mcp.json',
            'MCP Atlassian Docs'
          );
          if (sel === 'Open .vscode/mcp.json') {
            const mcpUri = vscode.Uri.joinPath(
              vscode.workspace.workspaceFolders![0].uri,
              '.vscode', 'mcp.json'
            );
            vscode.window.showTextDocument(mcpUri);
          } else if (sel === 'MCP Atlassian Docs') {
            vscode.env.openExternal(
              vscode.Uri.parse('https://github.com/sooperset/mcp-atlassian')
            );
          }
        }
      }
    );
  }

  // ── Store in-memory (never written to disk) ──────────────────────────────
  activeRequirements = { profileId: profile.id, text: requirementText };
  panelProvider.showWelcome(true, buildRequirementsLabel(requirementText));
  vscode.window.showInformationMessage(`✅ Requirements set for profile: ${profile.label}`);
}

async function clearTicketRequirements() {
  activeRequirements = undefined;
  panelProvider.showWelcome(false, '');
  vscode.window.showInformationMessage(`✅ Requirements cleared`);
}

export function deactivate() {}
