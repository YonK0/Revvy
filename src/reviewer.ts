// src/reviewer.ts
// Core review engine: builds prompts from YAML rules, calls AI, parses results.
//
// Changes vs original:
//   P3 — runReview() now fans out one AI call per file in parallel (Promise.all).
//        Each file gets its own focused prompt → smaller inputs → lower TTFT.
//        Results are merged into a single ReviewResult identical in shape to before,
//        so callers and the UI need no changes.
//   P4 — buildRepoContext() extracts changed symbols from the diff and searches
//        the workspace for cross-file usages, then injects a concise context block
//        into each per-file system prompt.
//   P0 — filterDiff / splitDiffByFile from diffFilter.ts are used here.
//   P2 — onChunk (StreamChunkCallback) is threaded through to callAI.
//   PERF-1 — buildRepoContext() aggressively capped: 3 symbols, 3 files, 500 chars.
//            File reads are batched via a shared workspace cache.
//   PERF-2 — System prompt is built ONCE and reused across all parallel file reviews.
//            Only the small repo-context suffix varies per file.
//   PERF-3 — Concurrency limiter: max 2 AI calls in-flight at once to prevent
//            API rate-limit thrashing and memory pressure on large diffs.

import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewProfile, ReviewRule } from './ruleLoader';
import { callAI, AIResponse, AIKeys, StreamChunkCallback } from './aiBackend';
import { filterDiff, splitDiffByFile } from './diffFilter';

export interface ReviewComment {
  file: string;
  line: number;
  endLine?: number;
  severity: 'error' | 'warning' | 'suggestion' | 'praise';
  ruleId?: string;
  ruleTitle?: string;
  message: string;
  suggestion?: string;
  /** Lines extracted from the diff around the flagged range (remote reviews only). */
  codeContext?: string;
  /** 1-based line number of the first line stored in codeContext. */
  codeContextStartLine?: number;
  /**
   * Verbatim 1–3 lines copied from the diff by the AI identifying the exact
   * code being flagged.  Used to correct the highlight when the AI's `line`
   * number is slightly off from the actual offending code.
   */
  codeFragment?: string;
}

export interface ReviewSource {
  ref: string;
  repo: string;
  mrNumber: number;
  type: 'github' | 'gitlab' | 'local';
}

export interface ReviewTest {
  title: string;
  category: 'functional' | 'security' | 'boundary' | 'performance';
  steps: string[];
}

// Category display order: functional → boundary → performance → security
const CATEGORY_ORDER: Record<ReviewTest['category'], number> = {
  functional:  0,
  boundary:    1,
  performance: 2,
  security:    3,
};

function sortTestsByCategory(tests: ReviewTest[]): ReviewTest[] {
  return [...tests].sort((a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff-context helpers (used for remote MR reviews)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts ±contextLines lines around [startLine, endLine] from a unified diff.
 *
 * Parses @@ hunk headers to map new-side line numbers → code text, then
 * slices the window. Returns undefined if no relevant lines can be found.
 */
function extractDiffContext(
  fileDiff: string,
  startLine: number,
  endLine: number | undefined,
  contextLines = 2,
  codeFragment?: string,
): { code: string; startLineNum: number; correctedLine: number } | undefined {
  // Build newLineNum → codeLine map from the diff hunks.
  //
  // FIX 1 — bounded hunk consumer:
  // We parse each @@ header for the exact new-side line count (newCount) and
  // consume precisely that many new-side lines (+/ ) before stopping.  Any
  // content after the hunk (appended JSON metadata, blank lines, next headers)
  // never touches lineMap.  This also eliminates the +++ b/filename bug: that
  // header is a non-@@ outer-loop line and is skipped by the else branch.
  // Normalise Windows CRLF so \r never bleeds into lineMap values.
  const lineMap = new Map<number, string>();
  const lines = fileDiff.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    // Match: @@ -a[,b] +newStart[,newCount] @@
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      let currentNewLine = parseInt(hunk[1], 10);
      // newCount: the ,N part of +start,N.  Absent means exactly 1 line.
      const newCount = hunk[2] !== undefined ? parseInt(hunk[2], 10) : 1;
      let remaining = newCount;
      i++; // advance past the @@ header line

      while (remaining > 0 && i < lines.length) {
        const line = lines[i];
        if (line.startsWith(' ')) {
          lineMap.set(currentNewLine++, line.slice(1));
          remaining--;
          i++;
        } else if (line.startsWith('+')) {
          lineMap.set(currentNewLine++, line.slice(1));
          remaining--;
          i++;
        } else if (line.startsWith('-')) {
          // removed line — no new-side line number; does not consume remaining
          i++;
        } else if (line.startsWith('\\')) {
          // "\ No newline at end of file" and similar diff metadata markers.
          // Skip without breaking the hunk — remaining is unchanged.
          i++;
        } else {
          // Non-diff content (metadata, next @@ header, blank line after hunk).
          // Stop consuming without advancing i — outer loop will re-process.
          break;
        }
      }
    } else {
      i++; // skip diff headers (diff --git, index, ---, +++) and other non-hunk lines
    }
  }

  if (lineMap.size === 0) { return undefined; }

  // Shared distance cap used by both the fragment-guided correction (FIX 3) and
  // the nearest-available-line fallback (FIX 2) below.
  const MAX_FALLBACK_DIST = 30;

  // FIX 3 — codeFragment-guided line correction:
  // When the AI provides a verbatim codeFragment we search the full lineMap for
  // the nearest entry whose text contains the fragment's first line.  This
  // corrects cases where the AI's reported line number is off by more than
  // ±contextLines — e.g. flagging the opening brace of a function when the
  // actual violation is the parameter on the function signature line 4 lines
  // later.  The search is bounded by MAX_FALLBACK_DIST so we never jump to a
  // completely unrelated part of the diff.
  let flagFirst = Math.max(1, startLine);
  let flagLast  = (endLine !== undefined && endLine >= flagFirst) ? endLine : flagFirst;

  if (codeFragment) {
    const fragFirstLine = codeFragment.split('\n')[0].replace(/^[+\- ]/, '').trim();
    const fragLineCount = codeFragment.split('\n').length;
    const MIN_FRAG_LEN  = 8;
    if (fragFirstLine.length >= MIN_FRAG_LEN) {
      let bestLine = -1;
      let bestDist = Infinity;
      for (const [ln, code] of lineMap) {
        const dist = Math.abs(ln - flagFirst);
        if (dist <= MAX_FALLBACK_DIST && dist < bestDist && code.trim().includes(fragFirstLine)) {
          bestLine = ln;
          bestDist = dist;
        }
      }
      if (bestLine !== -1) {
        flagFirst = bestLine;
        flagLast  = bestLine + fragLineCount - 1;
      }
    }
  }

  const viewFirst = Math.max(1, flagFirst - contextLines);
  const viewLast  = flagLast + contextLines;

  const collected: Array<{ ln: number; code: string }> = [];
  for (let ln = viewFirst; ln <= viewLast; ln++) {
    const code = lineMap.get(ln);
    if (code !== undefined) {
      collected.push({ ln, code });
    }
  }

  // FIX 2 — nearest-available-line fallback:
  // If the AI flagged a line just outside the hunk's context window, the exact
  // window produces no results.  Find the nearest in-diff line and return a
  // contextLines-wide window around it — but only if it's within MAX_FALLBACK_DIST
  // lines of the flagged line.  Beyond that threshold the snippet would be from
  // a completely unrelated area of the file; "Code not available" is more honest.
  if (collected.length === 0) {
    let nearestLine = -1;
    let nearestDist = Infinity;
    for (const ln of lineMap.keys()) {
      const dist = Math.abs(ln - flagFirst);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestLine = ln;
      }
    }
    if (nearestLine === -1 || nearestDist > MAX_FALLBACK_DIST) { return undefined; }
    const fallbackFirst = Math.max(1, nearestLine - contextLines);
    const fallbackLast  = nearestLine + contextLines;
    for (let ln = fallbackFirst; ln <= fallbackLast; ln++) {
      const code = lineMap.get(ln);
      if (code !== undefined) {
        collected.push({ ln, code });
      }
    }
    if (collected.length === 0) { return undefined; }
  }

  return {
    code:          collected.map(l => l.code).join('\n'),
    startLineNum:  collected[0].ln,
    correctedLine: flagFirst,
  };
}

/**
 * Mutates each comment in `comments` to attach diff-sourced code context.
 * Only processes comments with a positive line number.
 */
function attachDiffContext(comments: ReviewComment[], fileDiff: string): void {
  for (const c of comments) {
    if (c.line <= 0) { continue; }
    const ctx = extractDiffContext(fileDiff, c.line, c.endLine, 2, c.codeFragment);
    if (ctx) {
      c.codeContext          = ctx.code;
      c.codeContextStartLine = ctx.startLineNum;
      // FIX 3: update c.line to the fragment-corrected value so the card header
      // and highlight both point to the actual offending line, not the AI-guessed one.
      c.line = ctx.correctedLine;
    }
  }
}

/**
 * Mutates each comment in `comments` to attach diff-sourced code context,
 * matching each comment to its file's diff section via filePath lookup.
 *
 * Lookup order for each comment's c.file:
 *   1. Exact path match  (e.g. "src/foo.c"  →  "src/foo.c")
 *   2. Basename match    (e.g. "foo.c"       →  "src/foo.c")
 *
 * If neither matches, the comment is skipped — we never fall back to the
 * combined multi-file diff.  Passing a combined diff to extractDiffContext
 * collapses line numbers from all files into one shared namespace, so a
 * "line 19" in file A can be silently overwritten by "line 19" in file B.
 */
function attachDiffContextByFile(
  comments: ReviewComment[],
  fileSections: Array<{ filePath: string; diff: string }>
): void {
  const diffByFile     = new Map<string, string>();
  const diffByBasename = new Map<string, string>();
  for (const fs of fileSections) {
    diffByFile.set(fs.filePath, fs.diff);
    diffByBasename.set(path.basename(fs.filePath), fs.diff);
  }

  for (const c of comments) {
    if (c.line <= 0) { continue; }
    // Resolve to exactly one file's diff — never the combined diff.
    const fileDiff = diffByFile.get(c.file)
      ?? diffByBasename.get(path.basename(c.file));
    if (!fileDiff) { continue; }
    const ctx = extractDiffContext(fileDiff, c.line, c.endLine, 2, c.codeFragment);
    if (ctx) {
      c.codeContext          = ctx.code;
      c.codeContextStartLine = ctx.startLineNum;
      // FIX 3: update c.line to the fragment-corrected value (see attachDiffContext).
      c.line = ctx.correctedLine;
    }
  }
}

/** Per-file review result with source metadata. */
export interface FileReviewResult extends ReviewResult {
  filePath: string;
  isNewFile: boolean;
}

export interface ReviewResult {
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'NEEDS_DISCUSSION';
  score: number;
  summary: string;
  comments: ReviewComment[];
  conclusion: string;
  tests: ReviewTest[];
  /** Suggested commit messages generated from the local diff. Empty for remote reviews. */
  commitMessages: string[];
  sources?: ReviewSource[];
  profileUsed: string;
  modelUsed: string;
  backendUsed: string;
  durationMs: number;
  filterStats?: {
    keptFiles: number;
    skippedFiles: number;
    skippedFilePaths: string[];
    estimatedTokensSaved: number;
  };
  // PERF — token estimation for diagnostics
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERF-3 — Backend-aware concurrency limiter
//
// Each backend has a different safe parallelism ceiling:
//   copilot   — runs inside VS Code's single LM API connection; too many parallel
//               requests cause the host to serialize them anyway, so 3 is optimal.
//   openai    — GPT-4o standard tier supports high parallelism; 6 is safe.
//   anthropic — Claude standard tier; 5 is safe.
//
// The limit is read from VS Code config at the point a review starts, so it
// reflects any runtime backend switch without requiring an extension reload.
// ─────────────────────────────────────────────────────────────────────────────

const CONCURRENCY_BY_BACKEND: Record<string, number> = {
  copilot:   3,
  openai:    6,
  anthropic: 5,
};
const CONCURRENCY_DEFAULT = 4;   // fallback for unknown/future backends

function getMaxConcurrentCalls(): number {
  try {
    const backend = vscode.workspace.getConfiguration('revvy').get<string>('aiBackend', 'copilot');
    return CONCURRENCY_BY_BACKEND[backend] ?? CONCURRENCY_DEFAULT;
  } catch {
    return CONCURRENCY_DEFAULT;
  }
}

let activeAiCalls = 0;
const aiCallQueue: Array<() => void> = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  const limit = getMaxConcurrentCalls();
  if (activeAiCalls < limit) {
    activeAiCalls++;
    try { return await fn(); }
    finally {
      activeAiCalls--;
      const next = aiCallQueue.shift();
      if (next) { next(); }
    }
  }
  return new Promise<T>((resolve, reject) => {
    aiCallQueue.push(async () => {
      activeAiCalls++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        activeAiCalls--;
        const next = aiCallQueue.shift();
        if (next) { next(); }
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PERF-1 — Batched workspace file cache
// ─────────────────────────────────────────────────────────────────────────────

interface WorkspaceFileEntry {
  uri: vscode.Uri;
  relPath: string;
  content: string | null;
}

/**
 * Reads a batch of workspace files in parallel (up to 10 at a time)
 * and returns their contents. Failed reads return null.
 */
async function readWorkspaceFilesBatched(
  fileUris: vscode.Uri[],
  batchSize = 10
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (let i = 0; i < fileUris.length; i += batchSize) {
    const batch = fileUris.slice(i, i + batchSize);
    const promises = batch.map(async (uri) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return { path: uri.fsPath, content: new TextDecoder().decode(bytes) };
      } catch {
        return { path: uri.fsPath, content: null };
      }
    });
    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r.content !== null) {
        results.set(r.path, r.content);
      }
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// P4 — Repository context extraction (PERF-1 optimized)
// ─────────────────────────────────────────────────────────────────────────────

function extractChangedSymbols(fileDiff: string): string[] {
  const symbols = new Set<string>();
  const addedLines = fileDiff
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'));

  for (const line of addedLines) {
    const content = line.slice(1).trim();

    let m = content.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (m && !['if', 'for', 'while', 'switch', 'return', 'sizeof', 'typeof', 'alignof'].includes(m[1])) {
      symbols.add(m[1]);
    }

    m = content.match(/^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) { symbols.add(m[1]); }

    m = content.match(/\b(?:struct|enum|union|typedef)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (m) { symbols.add(m[1]); }

    m = content.match(/\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (m) { symbols.add(m[1]); }
    m = content.match(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
    if (m) { symbols.add(m[1]); }

    m = content.match(/^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (m) { symbols.add(m[1]); }
  }

  return Array.from(symbols);
}

/**
 * Builds cross-file context for a changed symbol search.
 * 
 * PERF optimizations:
 *   - Skipped entirely for new files (no existing code to reference)
 *   - Max 2 symbols (was 3) — most impactful only
 *   - Max 500 chars total
 *   - Max 2 files per symbol (was 3)
 *   - Batch file reads in parallel (was sequential)
 *   - Accepts pre-built sharedFileCache to avoid duplicate reads
 */
async function buildRepoContext(
  symbols: string[],
  changedFilePath: string,
  profile: ReviewProfile,
  sharedFileCache?: Map<string, string>,
  isNewFile = false
): Promise<string> {
  // PERF: skip entirely for new files — no existing code to reference
  if (isNewFile || symbols.length === 0) { return ''; }

  const symbolsToSearch = symbols.slice(0, 2);
  const CHAR_CAP = 500;

  const globPattern = profile.file_patterns
    .find(p => p !== '**/*') ?? profile.file_patterns[0] ?? '**/*';

  let workspaceFiles: vscode.Uri[];
  try {
    // PERF: reduced from 100 to 50 — most repos don't need more
    workspaceFiles = await vscode.workspace.findFiles(globPattern, '{**/node_modules/**,**/out/**,**/dist/**,**/build/**}', 50);
  } catch {
    return '';
  }

  const changedBaseName = path.basename(changedFilePath);
  const otherFiles = workspaceFiles.filter(f => !f.fsPath.endsWith(changedFilePath) && path.basename(f.fsPath) !== changedBaseName);

  if (otherFiles.length === 0) { return ''; }

  // FIX 3: use the shared cache if provided; otherwise build a local one.
  // When called from the parallel fan-out path the cache is pre-built once
  // for all files, so N parallel file reviews share O(1) disk reads total.
  let fileContents: Map<string, string>;
  if (sharedFileCache) {
    fileContents = sharedFileCache;
  } else {
    fileContents = await readWorkspaceFilesBatched(otherFiles);
  }

  const findings: string[] = [];
  let totalChars = 0;

  for (const symbol of symbolsToSearch) {
    if (totalChars >= CHAR_CAP) { break; }

    const symbolFindings: string[] = [];
    let filesChecked = 0;

    for (const fileUri of otherFiles) {
      if (filesChecked >= 2 || totalChars >= CHAR_CAP) { break; }

      const content = fileContents.get(fileUri.fsPath);
      if (!content) { continue; }

      if (!content.includes(symbol)) { continue; }
      filesChecked++;

      const lines = content.split('\n');
      let matchesInFile = 0;
      const relPath = vscode.workspace.asRelativePath(fileUri);

      for (let i = 0; i < lines.length && matchesInFile < 2; i++) {
        const line = lines[i];
        const idx = line.indexOf(symbol);
        if (idx === -1) { continue; }
        const before = idx > 0 ? line[idx - 1] : ' ';
        const after  = idx + symbol.length < line.length ? line[idx + symbol.length] : ' ';
        if (/[A-Za-z0-9_$]/.test(before) || /[A-Za-z0-9_$]/.test(after)) { continue; }

        const entry = `  ${relPath}:${i + 1}  →  ${line.trim()}`;
        symbolFindings.push(entry);
        totalChars += entry.length;
        matchesInFile++;
      }
    }

    if (symbolFindings.length > 0) {
      const block = `### Symbol: \`${symbol}\`\n${symbolFindings.join('\n')}`;
      findings.push(block);
    }
  }

  if (findings.length === 0) { return ''; }

  return `\n## Cross-File Context\n\n${findings.join('\n\n')}\n`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(
  profile: ReviewProfile,
  sources?: ReviewSource[],
  repoContext?: string,
  commitRules?: ReviewRule[]
): string {
  const enabledRules = profile.rules.filter(r => r.enabled);

  // PERF — compress rules into a compact table instead of verbose multi-line blocks.
  // Format: | ID | SEV | Title | Description (truncated to 80 chars) |
  // This cuts the rules section from ~2,000 chars to ~500 for 20 rules.
  const ruleLines = enabledRules.map(r => {
    const desc = r.description.length > 80 ? r.description.substring(0, 80) + '…' : r.description;
    const sug = r.suggestion ? ` → ${r.suggestion}` : '';
    return `| ${r.id} | ${r.severity} | ${r.title} | ${desc}${sug}`;
  });
  const rulesTable = ruleLines.join('\n');

  let ticketSection = '';
  if (profile.ticket_context) {
    const tc = profile.ticket_context;
    if (tc.raw_requirements) {
      ticketSection = `\n## Requirements\nCRITICAL: Verify changes fulfill: ${tc.raw_requirements.trim()}\n`;
    } else {
      const parts: string[] = [];
      if (tc.ticket_id) { parts.push(`Ticket: ${tc.ticket_id}`); }
      if (tc.requirements?.length) { parts.push(`Reqs: ${tc.requirements.join('; ')}`); }
      if (tc.acceptance_criteria?.length) { parts.push(`Accept: ${tc.acceptance_criteria.join('; ')}`); }
      if (tc.forbidden_changes?.length) { parts.push(`FORBIDDEN: ${tc.forbidden_changes.join('; ')}`); }
      if (parts.length > 0) {
        ticketSection = `\n## Requirements\nCRITICAL: Verify changes meet all requirements. ${parts.join('. ')}\n`;
      }
    }
  }

  let multiRepoSection = '';
  if (sources && sources.length > 1) {
    const sourceList = sources.map(s =>
      `  - ${s.type.toUpperCase()} ${s.type === 'gitlab' ? 'MR' : 'PR'} #${s.mrNumber} — ${s.repo}`
    ).join('\n');
    multiRepoSection = `\n## Multi-Repo Review (${sources.length} repos)\n${sourceList}\nFile format: "repo/filename". Flag cross-repo API mismatches, version conflicts, shared protocol breaks.\n`;
  }

  const repoContextSection = repoContext ?? '';

  // Build optional commit message section (local single-file path only).
  // commitRules come from the separate commit-style profile — never from the
  // active domain profile — so domain rules and commit rules stay decoupled.
  let commitMsgSection = '';
  if (commitRules && commitRules.length > 0) {
    const commitRuleLines = commitRules.map(r => {
      const sug = r.suggestion ? ` → ${r.suggestion}` : '';
      return `- [${r.id}] ${r.title}: ${r.description}${sug}`;
    }).join('\n');
    commitMsgSection = `
## Commit Messages
Generate 2-3 commit message suggestions for this diff in "commit_messages" array.
Each suggestion covers the FULL diff as a single commit — they are alternative phrasings of the same commit, not a per-file or per-area split.
Follow these rules exactly:
${commitRuleLines}
Each message must be a single string (subject line only, or subject + blank line + body).`;
  }

  // Extend JSON schema with commit_messages only when needed.
  const commitMsgSchema = commitRules && commitRules.length > 0
    ? `,"commit_messages":["<msg1>","<msg2>"]`
    : '';

  return `You are a professional code reviewer specializing in ${profile.label}.${profile.system_prompt_extra ? '\n\n' + profile.system_prompt_extra.trim() : ''}

## Rules (${enabledRules.length} enabled)
ID | Severity | Title | Description
---|----------|-------|------------
${rulesTable}

## Response Format (JSON only, no markdown fences)
{"verdict":"APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION","score":1-10,"summary":"<overview>","comments":[{"file":"<file>","line":<N>,"endLine":<N>,"severity":"error|warning|suggestion","ruleId":"<ID>","ruleTitle":"<title>","message":"<120 chars>","suggestion":"<raw code, \\n joined>","codeFragment":"<verbatim 1-3 lines from diff>"}],"conclusion":"<summary>","tests":[{"title":"<Feature area — failure mode in plain English>","category":"functional|security|boundary|performance","steps":["<imperative action>","<imperative action>","<imperative verification with exact expected result>"]}]${commitMsgSchema}}

## Rules
- "message": single sentence <120 chars, no explanations
- "line": line number of the exact expression, condition, or declaration that violates the rule — not the containing function header, not a surrounding brace; for an uninitialized variable, report the declaration line; for a Yoda condition, report the line with the comparison operator
- "codeFragment": copy verbatim the specific line(s) that directly contain the rule violation — the statement, condition, or declaration that must be changed; never copy closing braces, blank lines, or lines that are only structural context; do not include the leading diff prefix character (+ or -)
- "suggestion": raw code only, \\n joined, no fences, no prose; omit if no fix
- Score harshly: 7-8=acceptable, 5-6=needs work, 3-4=significant issues, 1-2=major problems
- No praise, focus on problems only
- Reference rule ID in every comment
- "tests": Generate system-level tests that any team member (developer, manager, QA) can read and execute. Each test MUST have a "category" field.
  ## Categories (include at least one from each category that applies):
  • "functional" — basic feature correctness, happy-path workflows, expected behavior under normal conditions.
  • "security" — data leakage, unauthorized access, unintended side effects on other data regions, lock leaks that block the system.
  • "boundary" — first/last element behavior, empty inputs, maximum sizes, state after partial failure, and verifying that only the intended data region is modified while all adjacent regions remain untouched.
  • "performance" — time impact of the change on real workflows, resource consumption, system responsiveness during the operation.
  ## Step format — OBSERVABLE ACTIONS ONLY:
  • Write steps as real-world actions a tester performs on the actual system. Think: what would a person physically do to verify this change works?
  • Steps must describe the WORKFLOW that triggers the behavior, NOT the code path itself.
  • CORRECT examples:
    - "Perform the main user workflow end-to-end and verify the expected output appears"
    - "Submit a request with the largest valid input size and verify the system handles it without error"
    - "Perform the operation under normal load and record the total time taken end-to-end"
    - "Attempt the same action with expired or missing credentials and verify the system rejects the request"
    - "Verify that only the intended data region is cleared and all adjacent data remains completely unchanged"
    - "Perform the same end-to-end workflow on every other product or service that uses this shared component and verify identical results"
  • WRONG examples (NEVER write steps like these):
    - "Set an internal feature flag to enabled and mock the lower-level handler to return failure" ← implementation detail, not a real-world action
    - "Verify the internal retry counter is exactly 3 after a timeout" ← internal diagnostic, not observable by a user
    - "Enable the fast-path mode using the raw configuration constant name" ← internal flag name, meaningless outside the codebase
    - "Call the processing function directly and assert the return code is success" ← code-level, not a workflow test
  • FORBIDDEN in every step: any name, identifier, or abbreviation visible in the source code — functions, variables, constants, opcodes, register names, command codes, component abbreviations, protocol fields. If a word exists in the diff, it cannot appear in a step.
  • NO hedge words (try, consider, maybe). Direct imperative commands only.
  • REQUIRED when the changed component is shared across projects: add a dedicated "functional" test that verifies the same observable behavior holds for every other consumer. If consumers cannot be determined from the diff, flag it explicitly as a test that must be run.
  ## Rules:
  • Every test must be understandable by a manager reading the review report.
  • Focus on OBSERVABLE SYSTEM BEHAVIOR: what the user/tester sees, what data changes, how long it takes, what error appears.
  • Title format: "<Feature area> — <what could go wrong in plain English>".
  • Omit entirely if the diff is purely cosmetic (whitespace, comments, renames with no logic change).
  • Max 6 scenarios total, up to 2 per category. Fewer sharp tests beat many shallow ones.
${ticketSection}${multiRepoSection}${repoContextSection ? '\n' + repoContextSection : ''}${commitMsgSection}`;
}

function buildUserPrompt(diff: string, options?: { allInOne?: boolean }): string {
  if (options?.allInOne) {
    return `Review this multi-file code diff.

CRITICAL INSTRUCTIONS:
- Only review lines that were ADDED (prefix: +) or REMOVED (prefix: -)
- DO NOT review context lines (lines without + or - prefix)
- The diff contains multiple files separated by standard "diff --git" headers
- For each finding, include the EXACT file path from the diff --git header (b/ side) in the "file" field
- Focus ONLY on the actual changes made by the developer

\`\`\`diff
${diff}
\`\`\`

Remember: Review ONLY lines starting with + or -. Every finding MUST include the correct file path.`;
  }
  return `Review this code diff.

CRITICAL INSTRUCTIONS:
- Only review lines that were ADDED (prefix: +) or REMOVED (prefix: -)
- DO NOT review context lines (lines without + or - prefix)
- Focus ONLY on the actual changes made by the developer
- Ignore unchanged code shown for context

\`\`\`diff
${diff}
\`\`\`

Remember: Review ONLY the lines starting with + or - in the diff above.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERF — Token estimation
// ─────────────────────────────────────────────────────────────────────────────

function estimateTokens(textOrLength: string | number): number {
  const len = typeof textOrLength === 'number' ? textOrLength : textOrLength.length;
  return Math.ceil(len / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Response parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to repair truncated JSON by auto-closing open structures.
 * AI responses often hit max_tokens mid-stream, producing incomplete JSON like:
 *   {"verdict":"REQUEST_CHANGES","summary":"fix the
 * We try to close it gracefully before giving up.
 */
function repairTruncatedJson(raw: string): string {
  let fixed = raw.trim();

  // If it already parses, great
  try { JSON.parse(fixed); return fixed; } catch { /* keep going */ }

  // Strip any trailing garbage after the last '}' or ']'
  const lastBrace = Math.max(fixed.lastIndexOf('}'), fixed.lastIndexOf(']'));
  if (lastBrace > 0) {
    fixed = fixed.substring(0, lastBrace + 1);
    try { JSON.parse(fixed); return fixed; } catch { /* keep going */ }
  }

  // Try to auto-close: count open braces/brackets and close them
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < fixed.length; i++) {
    const ch = fixed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }

  // If we're inside a string, close it first
  if (inString) { fixed += '"'; }

  // Close open brackets
  while (openBrackets > 0) { fixed += ']'; openBrackets--; }
  while (openBraces > 0) { fixed += '}'; openBraces--; }

  try { JSON.parse(fixed); return fixed; } catch { /* one more try */ }

  // Last resort: close any unclosed string then braces
  fixed = raw.trim();
  // Walk backwards from end to find last valid structure boundary
  let s = false, esc2 = false;
  for (let i = fixed.length - 1; i >= 0; i--) {
    const ch = fixed[i];
    if (esc2) { esc2 = false; continue; }
    if (ch === '\\') { esc2 = true; continue; }
    if (ch === '"') { s = !s; }
  }
  if (s) { fixed += '"'; }
  // Add minimal closing
  fixed += '}}}}';
  try { JSON.parse(fixed); return fixed; } catch { /* give up */ }

  return raw; // Return original — let JSON.parse throw with full context
}

function parseReviewResponse(
  raw: string,
  profile: ReviewProfile,
  aiResp: AIResponse,
  durationMs: number,
  sources?: ReviewSource[]
): ReviewResult {
  let clean = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const jsonMatch = clean.match(/\{[\s\S]*\}/);
  if (jsonMatch) { clean = jsonMatch[0]; }

  let parsed: any;
  try {
    parsed = JSON.parse(clean);
  } catch (error: any) {
    // Attempt repair — common when AI hits max_tokens and response is truncated
    const repaired = repairTruncatedJson(clean);
    try {
      parsed = JSON.parse(repaired);
      console.warn('[Revvy] AI response was truncated — repaired JSON successfully');
    } catch {
      throw new Error(
        `Failed to parse AI response as JSON: ${error.message}\n\n` +
        `Raw (first 500 chars): ${clean.substring(0, 500)}`
      );
    }
  }

  return {
    verdict: parsed.verdict || 'NEEDS_DISCUSSION',
    score: Math.min(10, Math.max(1, parseInt(parsed.score) || 5)),
    summary: parsed.summary || 'No summary provided',
    comments: (parsed.comments || []).map((c: any): ReviewComment => ({
      file: c.file || 'general',
      line: parseInt(c.line) || 0,
      endLine: c.endLine ? parseInt(c.endLine) : undefined,
      severity: c.severity || 'suggestion',
      ruleId: c.ruleId,
      ruleTitle: c.ruleTitle,
      message: c.message || '',
      suggestion: c.suggestion,
      codeFragment: typeof c.codeFragment === 'string' && c.codeFragment.trim() ? c.codeFragment.trim() : undefined,
    })),
    conclusion: parsed.conclusion || '',
    tests: sortTestsByCategory((parsed.tests || []).map((t: any): ReviewTest => ({
      title: t.title || 'Untitled Test',
      category: (['functional', 'security', 'boundary', 'performance'].includes(t.category) ? t.category : 'functional') as ReviewTest['category'],
      steps: Array.isArray(t.steps) ? t.steps.map((s: any) => String(s)) : [],
    }))),
    commitMessages: Array.isArray(parsed.commit_messages)
      ? parsed.commit_messages
          .filter((m: any) => typeof m === 'string' && m.trim().length > 0)
          .slice(0, 5)
      : [],
    sources,
    profileUsed: profile.label,
    modelUsed: aiResp.model,
    backendUsed: aiResp.backend,
    durationMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PERF-2 — Per-file review with cached system prompt base
// ─────────────────────────────────────────────────────────────────────────────

interface CachedPrompts {
  systemPromptBase: string;
  userPrompt: string;
}

async function reviewSingleFile(
  filePath: string,
  fileDiff: string,
  profile: ReviewProfile,
  keys: AIKeys,
  cachedPrompts: CachedPrompts,
  onChunk?: StreamChunkCallback,
  sharedFileCache?: Map<string, string>,
  isNewFile = false,
  isRemote = false    // true when the diff came from a remote source (GitHub/GitLab MCP)
): Promise<ReviewResult> {
  const symbols = extractChangedSymbols(fileDiff);
  // Skip cross-file context for:
  //   • new files (nothing to reference yet)
  //   • remote reviews — the local workspace is not the diff source, so
  //     searching it for symbol usages is meaningless and spawns rg processes
  //     against the entire workspace tree for every reviewed file.
  const repoContext = isRemote
    ? ''
    : await buildRepoContext(symbols, filePath, profile, sharedFileCache, isNewFile);

  const systemPrompt = repoContext
    ? cachedPrompts.systemPromptBase + repoContext + '\n\nConsider these callers / usages when assessing impact of the changes above.\n'
    : cachedPrompts.systemPromptBase;

  // PERF: trim context lines from diff for new files — all lines are new, no need for "only review +" instruction
  const userPrompt = isNewFile
    ? `Review this new file code:\n\n\`\`\`diff\n${fileDiff}\n\`\`\`\n\nApply the same rules as for changed code.`
    : buildUserPrompt(fileDiff);

  const start = Date.now();
  const aiResp = await callAI(userPrompt, systemPrompt, keys, onChunk);
  const durationMs = Date.now() - start;

  return parseReviewResponse(aiResp.text, profile, aiResp, durationMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict / score merging helpers
// ─────────────────────────────────────────────────────────────────────────────

function mergeVerdicts(verdicts: ReviewResult['verdict'][]): ReviewResult['verdict'] {
  if (verdicts.includes('REQUEST_CHANGES')) { return 'REQUEST_CHANGES'; }
  if (verdicts.includes('NEEDS_DISCUSSION')) { return 'NEEDS_DISCUSSION'; }
  return 'APPROVE';
}

function averageScore(scores: number[]): number {
  if (scores.length === 0) { return 5; }
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main review function (public API — backwards compatible)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lightweight dedicated AI call to generate commit message suggestions for a
 * multi-file local diff.  Called once after the parallel per-file fan-out
 * completes so the AI sees the full changeset context rather than individual
 * file snippets.
 *
 * Input is intentionally compact (~400-500 tokens):
 *   - List of changed files
 *   - Key symbols extracted from the diff
 *   - The merged review summary (already generated)
 *   - Commit-style rules
 */
async function generateCommitMessages(
  changedFiles: string[],
  symbols: string[],
  reviewSummary: string,
  commitRules: ReviewRule[],
  keys: AIKeys
): Promise<string[]> {
  const ruleLines = commitRules.map(r => {
    const sug = r.suggestion ? ` → ${r.suggestion}` : '';
    return `- [${r.id}] ${r.title}: ${r.description}${sug}`;
  }).join('\n');

  const systemPrompt =
    `You are a commit message writer. Return ONLY valid JSON: {"commit_messages":["<msg1>","<msg2>","<msg3>"]}\n` +
    `Follow these commit style rules:\n${ruleLines}`;

  const fileList = changedFiles.slice(0, 20).join(', ');
  const symbolList = symbols.slice(0, 10).join(', ');
  const userPrompt =
    `Generate 2-3 alternative commit messages for committing ALL of these changes together in ONE commit.\n` +
    `Each suggestion must describe the ENTIRE changeset — not a single file or part of it.\n` +
    `They are different phrasings of the same commit, not a split of changes across commits.\n` +
    `Changed files: ${fileList}\n` +
    (symbolList ? `Key symbols changed: ${symbolList}\n` : '') +
    `Review summary: ${reviewSummary.slice(0, 300)}\n` +
    `Return only the JSON object.`;

  try {
    const aiResp = await callAI(userPrompt, systemPrompt, keys);
    const clean = aiResp.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { return []; }
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.commit_messages)
      ? parsed.commit_messages
          .filter((m: any) => typeof m === 'string' && m.trim().length > 0)
          .slice(0, 5)
      : [];
  } catch (e: any) {
    console.log(`[Revvy] generateCommitMessages failed: ${e.message}`);
    return [];
  }
}

export async function runReview(
  diff: string,
  profile: ReviewProfile,
  sources?: ReviewSource[],
  keys: AIKeys = {},
  onChunk?: StreamChunkCallback,
  commitRules?: ReviewRule[],
  mode: 'per_file' | 'all_in_one' = 'per_file'
): Promise<ReviewResult> {
  if (!diff.trim()) {
    throw new Error('No diff to review');
  }

  const filterResult = filterDiff(diff);
  const filteredDiff = filterResult.filteredDiff.trim();

  if (!filteredDiff) {
    throw new Error('No reviewable changes found after filtering (only lock files / generated code changed)');
  }

  if (filterResult.skippedFiles > 0) {
    console.log(
      `[Revvy] Diff filter: kept ${filterResult.keptFiles} file(s), ` +
      `skipped ${filterResult.skippedFiles} (${filterResult.skippedFilePaths.join(', ')}), ` +
      `~${filterResult.estimatedTokensSaved} tokens saved`
    );
  }

  const isMultiRepo = sources && sources.length > 1;
  const fileSections = splitDiffByFile(filteredDiff);

  // isRemote = diff came from a GitHub/GitLab MCP source, not from local git.
  // Shared by both parallel and single-file paths below.
  const isRemote = !!(sources && sources.length > 0 && sources[0].type !== 'local');

  // FIX 2 — enable per-file fan-out for multi-MR reviews.
  // Previously gated off with `!isMultiRepo`, forcing the entire combined diff
  // through a single monolithic AI call regardless of how many files it contained.
  // Now multi-MR reviews fan out per file exactly like local reviews do.
  // Cross-repo context is preserved: sources[] is passed to buildSystemPrompt so
  // each per-file call still carries the multi-repo header and integration guidance.
  // A multi-repo review with 4 repos × 3 files each = 12 parallel AI calls
  // instead of 1 sequential mega-call.
  //
  // 'all_in_one' mode bypasses the fan-out entirely: the full combined diff is
  // sent as a single AI request. Useful for small MRs where cross-file context
  // matters more than parallelism.
  const useParallel = mode !== 'all_in_one' && fileSections.length > 1;

  let merged: ReviewResult;

  if (useParallel) {
    const start = Date.now();

    // PERF-2: Build system prompt ONCE (cached base without repo context).
    // For multi-repo reviews, sources[] is included here so every per-file
    // prompt carries the cross-repo integration context.
    const systemPromptBase = buildSystemPrompt(profile, sources, '');

    let sharedFileCache: Map<string, string> = new Map();
    if (!isRemote) {
      // FIX 3: Pre-build shared workspace file cache ONCE before fan-out.
      // All parallel reviewSingleFile() calls share this map — zero duplicate reads.
      // Only for local reviews where the workspace IS the diff source.
      const globPattern = profile.file_patterns.find(p => p !== '**/*') ?? profile.file_patterns[0] ?? '**/*';
      try {
        const wsFiles = await vscode.workspace.findFiles(globPattern, '{**/node_modules/**,**/out/**,**/dist/**,**/build/**}', 50);
        sharedFileCache = await readWorkspaceFilesBatched(wsFiles);
      } catch { /* cache stays empty — buildRepoContext will skip gracefully */ }
    }

    // PERF-3: Use concurrency-limited parallel execution
    const perFileResults = await Promise.all(
      fileSections.map(({ filePath, diff: fd, isNewFile }) =>
        withConcurrencyLimit(async () => {
          const result = await reviewSingleFile(filePath, fd, profile, keys, { systemPromptBase, userPrompt: '' }, onChunk, sharedFileCache, isNewFile, isRemote);
          // For remote reviews, attach diff-sourced code context to every comment
          // so the panel can render code without reading local workspace files.
          if (isRemote) { attachDiffContext(result.comments, fd); }
          return result;
        })
      )
    );

    const durationMs = Date.now() - start;

    const allComments = perFileResults.flatMap(r => r.comments);
    const allTests    = perFileResults.flatMap(r => r.tests);

    // Dedupe: same file + line + ruleId = same issue. Fall back to message
    // when ruleId is missing (older profile responses may omit it).
    const seenCommentKeys = new Set<string>();
    const uniqueComments = allComments.filter(c => {
      const key = `${c.file}|${c.line}|${c.ruleId ?? c.message.slice(0, 80)}`;
      if (seenCommentKeys.has(key)) { return false; }
      seenCommentKeys.add(key);
      return true;
    });

    const seenTestTitles = new Set<string>();
    const uniqueTests = allTests.filter(t => {
      if (seenTestTitles.has(t.title)) { return false; }
      seenTestTitles.add(t.title);
      return true;
    });

    const lastResult = perFileResults[perFileResults.length - 1];

    // PERF: estimate tokens
    const totalInputChars = systemPromptBase.length + filteredDiff.length;
    const totalOutputChars = perFileResults.reduce((sum, r) => sum + r.summary.length + r.conclusion.length + r.comments.reduce((cs, c) => cs + c.message.length + (c.suggestion?.length || 0), 0), 0);

    merged = {
      verdict:     mergeVerdicts(perFileResults.map(r => r.verdict)),
      score:       averageScore(perFileResults.map(r => r.score)),
      summary:     perFileResults.map(r => r.summary).filter(Boolean).join(' '),
      comments:    uniqueComments,
      conclusion:  perFileResults.map(r => r.conclusion).filter(Boolean).join(' '),
      tests:       sortTestsByCategory(uniqueTests),
      // Commit messages are NOT generated per-file (each file only sees its own
      // diff, producing file-scoped messages). Instead, generateCommitMessages()
      // is called once below with full changeset context.  Remote reviews skip
      // this entirely — commitMessages stays empty.
      commitMessages: [],
      sources,
      profileUsed: profile.label,
      modelUsed:   lastResult.modelUsed,
      backendUsed: lastResult.backendUsed,
      durationMs,
      filterStats: {
        keptFiles:           filterResult.keptFiles,
        skippedFiles:        filterResult.skippedFiles,
        skippedFilePaths:    filterResult.skippedFilePaths,
        estimatedTokensSaved: filterResult.estimatedTokensSaved,
      },
      estimatedInputTokens:  estimateTokens(totalInputChars),
      estimatedOutputTokens: estimateTokens(totalOutputChars),
    };

    // One lightweight extra AI call to generate commit messages for the full
    // changeset. Only for local reviews when commitRules are provided.
    if (!isRemote && commitRules && commitRules.length > 0) {
      const changedFiles = fileSections.map(s => s.filePath);
      const allSymbols = fileSections.flatMap(s => extractChangedSymbols(s.diff));
      const uniqueSymbols = [...new Set(allSymbols)];
      merged.commitMessages = await generateCommitMessages(
        changedFiles, uniqueSymbols, merged.summary, commitRules, keys
      );
    }
  } else {
    const systemPrompt = buildSystemPrompt(
      profile, sources, undefined,
      // Pass commitRules only for local reviews (single-file or all-in-one) so the
      // AI generates commit messages in the same call — zero extra round-trip cost.
      !isRemote ? commitRules : undefined
    );
    // Use the multi-file all-in-one prompt when mode is 'all_in_one' and the diff
    // spans more than one file — instructs the AI to attribute findings by file path.
    const userPrompt = buildUserPrompt(
      filteredDiff,
      { allInOne: mode === 'all_in_one' && fileSections.length > 1 }
    );

    const start = Date.now();
    const aiResp = await callAI(userPrompt, systemPrompt, keys, onChunk);
    const durationMs = Date.now() - start;

    merged = parseReviewResponse(aiResp.text, profile, aiResp, durationMs, sources);
    // For remote reviews, attach diff-sourced code context.
    // Use per-file diff matching so each comment gets its own file's diff.
    if (isRemote) {
      attachDiffContextByFile(merged.comments, fileSections);
      // Hard guard: never expose commit messages in remote reviews.
      merged.commitMessages = [];
    }
    merged.filterStats = {
      keptFiles:           filterResult.keptFiles,
      skippedFiles:        filterResult.skippedFiles,
      skippedFilePaths:    filterResult.skippedFilePaths,
      estimatedTokensSaved: filterResult.estimatedTokensSaved,
    };
    merged.estimatedInputTokens  = estimateTokens(systemPrompt + userPrompt);
    merged.estimatedOutputTokens = estimateTokens(aiResp.text);
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect profile from file patterns (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export function autoDetectProfile(filePaths: string[], profiles: ReviewProfile[]): ReviewProfile | undefined {
  const scores = profiles.map(p => {
    let score = 0;
    for (const file of filePaths) {
      for (const pattern of p.file_patterns) {
        const ext = pattern.replace('**/*', '');
        if (file.endsWith(ext) || pattern === '**/*') {
          score += pattern === '**/*' ? 0.5 : 1;
        }
      }
    }
    return { profile: p, score };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores[0]?.score > 0 ? scores[0].profile : undefined;
}
