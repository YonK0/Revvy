// src/__tests__/reviewer.test.ts
// Unit tests for the response parsing logic inside runReview.
// callAI (which calls vscode.lm / OpenAI / Anthropic) is fully mocked so
// these tests run in Node without a VS Code host.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewProfile } from '../ruleLoader';

// ---------------------------------------------------------------------------
// Mock the aiBackend module BEFORE importing reviewer so the module-level
// import of callAI is replaced by our spy from the start.
// ---------------------------------------------------------------------------
vi.mock('../aiBackend', () => ({
  callAI: vi.fn(),
}));

import { runReview } from '../reviewer';
import { callAI } from '../aiBackend';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCallAI = vi.mocked(callAI);

/** Minimal profile that satisfies the ReviewProfile interface */
const baseProfile: ReviewProfile = {
  id: 'test',
  label: 'Test Profile',
  description: '',
  file_patterns: ['**/*'],
  system_prompt_extra: '',
  rules: [
    {
      id: 'NO_CONSOLE',
      severity: 'warning',
      enabled: true,
      title: 'No console.log',
      description: 'Do not use console.log in production',
    },
  ],
};

/** Minimal valid diff that is non-empty */
const SAMPLE_DIFF = `diff --git a/foo.ts b/foo.ts\n+console.log('hello');\n`;

/** Wrap an AI response payload */
function makeAIResponse(text: string) {
  return {
    text,
    model: 'gpt-4o',
    backend: 'openai',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runReview — parseReviewResponse (via mocked callAI)', () => {
  beforeEach(() => {
    mockCallAI.mockReset();
  });

  it('parses a clean JSON response with comments correctly', async () => {
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          score: 4,
          summary: 'Found one issue.',
          comments: [
            {
              file: 'foo.ts',
              line: 1,
              severity: 'warning',
              ruleId: 'NO_CONSOLE',
              ruleTitle: 'No console.log',
              message: 'console.log found in production code',
            },
          ],
          conclusion: 'Remove console.log before merging.',
          tests: [],
        })
      )
    );

    const result = await runReview(SAMPLE_DIFF, baseProfile);

    expect(result.verdict).toBe('REQUEST_CHANGES');
    expect(result.score).toBe(4);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].file).toBe('foo.ts');
    expect(result.comments[0].severity).toBe('warning');
    expect(result.modelUsed).toBe('gpt-4o');
    expect(result.backendUsed).toBe('openai');
  });

  it('strips markdown ```json fences before parsing', async () => {
    const json = JSON.stringify({
      verdict: 'APPROVE',
      score: 9,
      summary: 'Looks good.',
      comments: [],
      conclusion: 'Ship it.',
      tests: [],
    });

    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(`\`\`\`json\n${json}\n\`\`\``)
    );

    const result = await runReview(SAMPLE_DIFF, baseProfile);

    expect(result.verdict).toBe('APPROVE');
    expect(result.score).toBe(9);
    expect(result.comments).toHaveLength(0);
  });

  it('extracts JSON embedded in surrounding prose text', async () => {
    const json = JSON.stringify({
      verdict: 'NEEDS_DISCUSSION',
      score: 6,
      summary: 'A few things to discuss.',
      comments: [],
      conclusion: 'Review with team.',
      tests: [],
    });

    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(`Here is my review:\n\n${json}\n\nLet me know if you have questions.`)
    );

    const result = await runReview(SAMPLE_DIFF, baseProfile);

    expect(result.verdict).toBe('NEEDS_DISCUSSION');
    expect(result.score).toBe(6);
  });

  it('clamps score to the valid range 1–10 (score: -5 becomes 1)', async () => {
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          score: -5,          // below minimum — Math.max(1, -5) = 1
          summary: 'Terrible code.',
          comments: [],
          conclusion: 'Rewrite needed.',
          tests: [],
        })
      )
    );

    const result = await runReview(SAMPLE_DIFF, baseProfile);

    expect(result.score).toBe(1);
  });

  it('defaults missing fields (verdict, file, severity) to fallback values', async () => {
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          // verdict omitted — should default to 'NEEDS_DISCUSSION'
          score: 5,
          summary: 'Partial response.',
          comments: [
            {
              // file and severity omitted — should default
              line: 2,
              message: 'Something looks off',
            },
          ],
          conclusion: '',
          tests: [],
        })
      )
    );

    const result = await runReview(SAMPLE_DIFF, baseProfile);

    expect(result.verdict).toBe('NEEDS_DISCUSSION');
    expect(result.comments[0].file).toBe('general');
    expect(result.comments[0].severity).toBe('suggestion');
  });
});

// ---------------------------------------------------------------------------
// Remote MR — codeContext attachment
// ---------------------------------------------------------------------------

/**
 * A realistic single-file unified diff with a proper @@ hunk header.
 * Lines 1–6 are context, lines 7–8 are added (new-side lines 7 and 8).
 */
const REMOTE_DIFF = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index abc..def 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,6 +1,8 @@',
  ' function login(user: string) {',   // new-side line 1
  '   const session = createSession();', // new-side line 2
  '   if (!session) {',                  // new-side line 3
  '+    throw new Error("session failed");', // new-side line 4 (added)
  '+    return null;',                   // new-side line 5 (added)
  '   }',                                // new-side line 6
  '   return session;',                  // new-side line 7
  ' }',                                  // new-side line 8
].join('\n');

const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 42, type: 'github' as const }];

describe('runReview — remote MR codeContext attachment', () => {
  beforeEach(() => {
    mockCallAI.mockReset();
  });

  it('attaches codeContext to comments when sources indicate a remote review', async () => {
    // AI flags line 4 — the first added line
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          score: 5,
          summary: 'Missing error handling.',
          comments: [
            {
              file: 'src/auth.ts',
              line: 4,
              severity: 'error',
              message: 'throw without cleanup',
            },
          ],
          conclusion: 'Fix before merging.',
          tests: [],
        })
      )
    );

    const result = await runReview(REMOTE_DIFF, baseProfile, remoteSource);

    const comment = result.comments[0];
    expect(comment.codeContext).toBeDefined();
    expect(comment.codeContextStartLine).toBeDefined();

    // The context window (±2) around line 4 should start at line 2 at the earliest
    expect(comment.codeContextStartLine).toBeGreaterThanOrEqual(2);
    expect(comment.codeContextStartLine).toBeLessThanOrEqual(4);

    // The flagged line content must appear in the extracted context
    expect(comment.codeContext).toContain('throw new Error');
  });

  it('does NOT attach codeContext for local reviews (sources absent)', async () => {
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'APPROVE',
          score: 8,
          summary: 'Looks good.',
          comments: [
            {
              file: 'src/auth.ts',
              line: 4,
              severity: 'suggestion',
              message: 'Minor style note.',
            },
          ],
          conclusion: 'Ship it.',
          tests: [],
        })
      )
    );

    // No sources argument — treated as local review
    const result = await runReview(REMOTE_DIFF, baseProfile);

    expect(result.comments[0].codeContext).toBeUndefined();
    expect(result.comments[0].codeContextStartLine).toBeUndefined();
  });

  it('does NOT attach codeContext when sources type is local', async () => {
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'APPROVE',
          score: 9,
          summary: 'Fine.',
          comments: [
            { file: 'src/auth.ts', line: 4, severity: 'suggestion', message: 'ok' },
          ],
          conclusion: '',
          tests: [],
        })
      )
    );

    const localSource = [{ ref: 'HEAD', repo: 'local', mrNumber: 0, type: 'local' as const }];
    const result = await runReview(REMOTE_DIFF, baseProfile, localSource);

    expect(result.comments[0].codeContext).toBeUndefined();
  });

  // ── Fix 1: bounded hunk consumer ────────────────────────────────────────────

  it('does NOT include appended JSON metadata as code context (Fix 1)', async () => {
    // Simulate the GitLab MCP response: a real diff hunk followed by JSON
    // metadata that the MCP tool appends to the diff text.  Lines like
    // `  "details_path": "..."` start with spaces and used to be treated as
    // diff context lines by the old unbounded loop.
    const diffWithJsonTail = [
      'diff --git a/src/utils.ts b/src/utils.ts',
      'index 111..222 100644',
      '--- a/src/utils.ts',
      '+++ b/src/utils.ts',
      '@@ -10,3 +10,4 @@',
      ' function helper() {',      // new-side line 10
      '+  const x = compute();',   // new-side line 11  (added)
      '   return x;',              // new-side line 12
      ' }',                        // new-side line 13
      // Appended JSON metadata — must NOT enter lineMap
      '{',
      '  "details_path": "/pipelines/99",',
      '  "renamed_file": false,',
      '  "generated_file": false',
      '}',
    ].join('\n');

    // AI flags line 11 (the added line)
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          score: 5,
          summary: 'Potential issue.',
          comments: [
            { file: 'src/utils.ts', line: 11, severity: 'warning', message: 'side effect' },
          ],
          conclusion: 'Fix it.',
          tests: [],
        })
      )
    );

    const result = await runReview(diffWithJsonTail, baseProfile, remoteSource);
    const comment = result.comments[0];

    // codeContext must be defined (line 11 is inside the hunk)
    expect(comment.codeContext).toBeDefined();
    // The JSON keys must NOT appear anywhere in the extracted context
    expect(comment.codeContext).not.toContain('details_path');
    expect(comment.codeContext).not.toContain('renamed_file');
    expect(comment.codeContext).not.toContain('generated_file');
    // The actual code line must be present
    expect(comment.codeContext).toContain('compute()');
  });

  // ── Fix 2: nearest-available-line fallback ───────────────────────────────────

  it('returns nearest-available context when AI flags a line outside the hunk (Fix 2)', async () => {
    // The hunk covers new-side lines 1–8. The AI flags line 50 (way outside).
    // Fix 2 should return a context window around the nearest available line
    // instead of returning undefined (which would leave codeContext undefined).
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          score: 4,
          summary: 'Missing guard.',
          comments: [
            { file: 'src/auth.ts', line: 50, severity: 'error', message: 'no null check' },
          ],
          conclusion: 'Add guard.',
          tests: [],
        })
      )
    );

    // REMOTE_DIFF covers lines 1–8 only
    const result = await runReview(REMOTE_DIFF, baseProfile, remoteSource);
    const comment = result.comments[0];

    // Nearest-line fallback must have fired — codeContext must be defined
    expect(comment.codeContext).toBeDefined();
    expect(comment.codeContextStartLine).toBeDefined();

    // The fallback window must come from within the hunk (lines 1–8)
    expect(comment.codeContextStartLine).toBeGreaterThanOrEqual(1);
    expect(comment.codeContextStartLine).toBeLessThanOrEqual(8);

    // Must contain real diff content, not an empty string
    expect(comment.codeContext!.trim().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — Bug 2 Part 1: per-comment diff matching
// ---------------------------------------------------------------------------

describe('Bug 2 Part 1: per-comment diff matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('single-file non-parallel path: uses correct file for comment matching', async () => {
    // Single file diff triggers useParallel=false path
    const singleFileDiff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-const old = 1;
+const newAuth = 1;`;

    const remoteSource = { ref: 'MR #1', repo: 'test/repo', mrNumber: 1, type: 'gitlab' as const };

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 3,
        summary: 'Found issue',
        comments: [
          { file: 'src/auth.ts', line: 1, severity: 'error', ruleId: 'SEC01', message: 'null check needed' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const result = await runReview(singleFileDiff, baseProfile, remoteSource);

    // Comment should exist
    expect(result.comments).toHaveLength(1);
    const comment = result.comments[0];

    // Comment should have its file path set correctly (not undefined)
    expect(comment.file).toBe('src/auth.ts');
  });

  it('multi-file path: processes each file with its own diff', async () => {
    // Two files - triggers parallel path
    const twoFileDiff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-const old = 1;
+const newAuth = 1;

diff --git a/src/db.ts b/src/db.ts
--- a/src/db.ts
+++ b/src/db.ts
@@ -10 +10 @@
-const db = null;
+const db = connect();`;

    const remoteSource = { ref: 'MR #1', repo: 'test/repo', mrNumber: 1, type: 'gitlab' as const };

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'APPROVE',
        score: 10,
        summary: 'OK',
        comments: [],
        conclusion: 'OK',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    // For parallel review (2 files), there's no per-file AI response 
    // - the mock returns empty comments. This test just verifies 
    // the parallel path executes without error.
    const result = await runReview(twoFileDiff, baseProfile, remoteSource);
    expect(result.comments).toHaveLength(0);
  });
});
