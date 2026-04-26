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

  it('returns nearest-available context when AI flags a line just outside the hunk (Fix 2)', async () => {
    // The hunk covers new-side lines 1–8.  The AI flags line 11 (3 lines beyond
    // the hunk end — within MAX_FALLBACK_DIST=30).  The fallback should fire and
    // return a window around the nearest in-hunk line.
    mockCallAI.mockResolvedValueOnce(
      makeAIResponse(
        JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          score: 4,
          summary: 'Missing guard.',
          comments: [
            { file: 'src/auth.ts', line: 11, severity: 'error', message: 'no null check' },
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

// ---------------------------------------------------------------------------
// Tests — snippet extraction correctness (extractDiffContext / attachDiffContextByFile)
// ---------------------------------------------------------------------------

describe('snippet extraction — multi-file collision fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The primary bug: two files both have a hunk at line 15.
   * Before the fix, the combined diff was passed to extractDiffContext,
   * which collapsed both files' line 15 into one shared lineMap — the second
   * file's content overwrote the first's.  After the fix, each comment is
   * resolved against only its own file's diff section.
   */
  it('primary bug: two files with overlapping line numbers — comment gets its own file\'s code', async () => {
    // File A: hunk at line 15, content "const authToken = …"
    // File B: hunk at line 15, content "const dbPassword = …"
    // Both files changed the same line number.
    const twoFileDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -13,3 +13,4 @@',
      ' // auth helpers',
      ' function init() {',
      '+const authToken = getToken();',   // new-side line 15 in auth.ts
      ' }',
      'diff --git a/src/db.ts b/src/db.ts',
      '--- a/src/db.ts',
      '+++ b/src/db.ts',
      '@@ -13,3 +13,4 @@',
      ' // db helpers',
      ' function connect() {',
      '+const dbPassword = getSecret();', // new-side line 15 in db.ts
      ' }',
    ].join('\n');

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];

    // AI flags auth.ts line 15
    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 3,
        summary: 'Credential handling issue',
        comments: [
          { file: 'src/auth.ts', line: 15, severity: 'error', message: 'token exposed' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const result = await runReview(twoFileDiff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // Must have attached context
    expect(comment.codeContext).toBeDefined();

    // Must contain auth.ts content — NOT db.ts content
    expect(comment.codeContext).toContain('authToken');
    expect(comment.codeContext).not.toContain('dbPassword');
  });

  it('distance cap: AI flags a line far beyond the diff hunk → codeContext is undefined', async () => {
    // REMOTE_DIFF hunk covers lines 1–8.  Line 50 is 42 lines away — beyond
    // MAX_FALLBACK_DIST=30.  The fallback must NOT fire; codeContext stays undefined.
    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 4,
        summary: 'Issue.',
        comments: [
          { file: 'src/auth.ts', line: 50, severity: 'error', message: 'far away' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];
    const result = await runReview(REMOTE_DIFF, baseProfile, remoteSource);

    expect(result.comments[0].codeContext).toBeUndefined();
  });

  it('Windows CRLF: diff with \\r\\n line endings — codeContext has no trailing \\r', async () => {
    // Simulate a diff fetched from a Windows environment or CRLF-normalised server.
    const crlfDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,2 +1,3 @@',
      ' function login() {',
      '+  const x = 1;',   // new-side line 2
      ' }',
    ].join('\r\n'); // <-- Windows line endings throughout

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 5,
        summary: 'Issue.',
        comments: [
          { file: 'src/auth.ts', line: 2, severity: 'warning', message: 'unused var' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];
    const result = await runReview(crlfDiff, baseProfile, remoteSource);
    const comment = result.comments[0];

    expect(comment.codeContext).toBeDefined();
    // No line in the context should have a trailing \r
    const lines = comment.codeContext!.split('\n');
    for (const line of lines) {
      expect(line.endsWith('\r')).toBe(false);
    }
  });

  it('no-newline marker: \\ No newline at end of file does not truncate the hunk', async () => {
    // Diff where the last added line has no trailing newline.
    // The "\ No newline at end of file" marker must be skipped — not break
    // the hunk consumer early — so all added lines appear in codeContext.
    const noNewlineDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,2 +1,3 @@',
      ' function login() {',
      '+  const token = auth();',   // new-side line 2
      '+  return token;',           // new-side line 3
      '\\ No newline at end of file',
      ' }',
    ].join('\n');

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 5,
        summary: 'Issue.',
        comments: [
          { file: 'src/auth.ts', line: 3, severity: 'warning', message: 'token leak' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];
    const result = await runReview(noNewlineDiff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // Both added lines must be in the extracted context
    expect(comment.codeContext).toBeDefined();
    expect(comment.codeContext).toContain('token = auth()');
    expect(comment.codeContext).toContain('return token');
  });

  it('basename matching: AI returns filename without path — still resolves to correct diff', async () => {
    // fileSections key is "src/auth.ts"; AI returns c.file = "auth.ts" (basename only).
    // attachDiffContextByFile must find the diff via basename fallback.
    const singleFileDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,2 +1,3 @@',
      ' function login() {',
      '+  const session = createSession();',  // new-side line 2
      ' }',
    ].join('\n');

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 5,
        summary: 'Issue.',
        comments: [
          // AI returns basename only — no directory prefix
          { file: 'auth.ts', line: 2, severity: 'warning', message: 'session not checked' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];
    const result = await runReview(singleFileDiff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // Should still attach context via basename match
    expect(comment.codeContext).toBeDefined();
    expect(comment.codeContext).toContain('createSession');
  });

  it('no combined-diff fallback: unknown file in comment → codeContext stays undefined', async () => {
    // AI returns a comment for a file not present in the diff at all.
    // Must NOT fall back to the combined diff — codeContext must remain undefined.
    const singleFileDiff = [
      'diff --git a/src/auth.ts b/src/auth.ts',
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1 +1,2 @@',
      ' function login() {',
      '+  return true;',   // new-side line 2
      ' }',
    ].join('\n');

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 5,
        summary: 'Issue.',
        comments: [
          // AI hallucinated a file that isn't in the diff
          { file: 'src/totally-unknown-file.ts', line: 2, severity: 'error', message: 'oops' },
        ],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];
    const result = await runReview(singleFileDiff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // No match → no context. Must not show a snippet from auth.ts.
    expect(comment.codeContext).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — codeFragment parsing
// ---------------------------------------------------------------------------

describe('codeFragment — parsed from AI response and attached to comment', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /**
   * Real-world scenario: AI flags L1398 (a closing brace `}`) for a
   * wrong-prefix variable, but the actual declaration is at L1395.  The AI
   * includes the verbatim declaration as codeFragment.
   *
   * FIX 3: extractDiffContext now searches the full lineMap for the fragment
   * and corrects c.line to the actual declaration line (1395) before the
   * context window is even extracted.  The card header, dedup key, and
   * highlight all use the corrected line — no panel-side search needed.
   */
  it('codeFragment corrects c.line to the actual offending line (extraction-layer fix)', async () => {
    const diff = [
      'diff --git a/src/DrvGLCD.cpp b/src/DrvGLCD.cpp',
      '--- a/src/DrvGLCD.cpp',
      '+++ b/src/DrvGLCD.cpp',
      '@@ -1393,6 +1393,6 @@',
      ' if (u08character >= 0x20)',
      ' {',
      '+U08 u08asciiIndex = u08character - 0x20;',  // new-side line 1395
      ' memcpy(&buf[column], LCD_ASCII[u08asciiIndex], WIDTH);',
      ' column += WIDTH;',
      ' }',
    ].join('\n');

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];

    // AI reports line 1398 (the `}`) but includes the declaration as codeFragment
    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 4,
        summary: 'Naming issue.',
        comments: [{
          file: 'src/DrvGLCD.cpp',
          line: 1398,
          severity: 'error',
          ruleId: 'NAMING',
          message: 'Wrong prefix: u08asciiIndex should be u8AsciiIndex',
          codeFragment: 'U08 u08asciiIndex = u08character - 0x20;',
        }],
        conclusion: 'Fix naming.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const result = await runReview(diff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // codeFragment must be preserved on the comment exactly as provided
    expect(comment.codeFragment).toBe('U08 u08asciiIndex = u08character - 0x20;');
    // FIX 3: c.line is now corrected to the declaration line, not the AI-guessed one
    expect(comment.line).toBe(1395);
    // The extracted context must contain the declaration line
    expect(comment.codeContext).toContain('U08 u08asciiIndex = u08character - 0x20;');
    // codeContextStartLine must be at or before the corrected line
    expect(comment.codeContextStartLine).toBeLessThanOrEqual(1395);
  });

  it('codeFragment is omitted from comment when AI does not provide it', async () => {
    const diff = [
      'diff --git a/src/foo.c b/src/foo.c',
      '--- a/src/foo.c',
      '+++ b/src/foo.c',
      '@@ -1,2 +1,3 @@',
      ' void init() {',
      '+  x = 1;',
      ' }',
    ].join('\n');

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 6,
        summary: 'Minor issue.',
        comments: [{
          file: 'src/foo.c',
          line: 2,
          severity: 'warning',
          message: 'Uninitialised variable',
          // No codeFragment field — older AI response or profile without the rule
        }],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const result = await runReview(diff, baseProfile, remoteSource);
    // Must be undefined, not null / empty string
    expect(result.comments[0].codeFragment).toBeUndefined();
  });

  /**
   * Mirrors the real-world DrvMTR.cpp scenario from the bug report:
   * the new function starts at line 14910 but the AI reports line 14906
   * (the `}` closing the previous function — 4 lines before the signature).
   * With the default ±2 context window the signature was completely invisible;
   * now extractDiffContext uses the codeFragment to shift the window.
   */
  it('codeFragment corrects line when fragment is outside the default ±2 context window', async () => {
    // Simulate the DrvMTR.cpp hunk: 3 context lines + 18 added lines
    const diff = [
      'diff --git a/src/DrvMTR.cpp b/src/DrvMTR.cpp',
      '--- a/src/DrvMTR.cpp',
      '+++ b/src/DrvMTR.cpp',
      '@@ -14887,3 +14905,21 @@',
      '     return E_DrvMTR_Ret_Success;',        // L14905 context
      ' }',                                        // L14906 context
      ' #endif',                                   // L14907 context
      '+',                                         // L14908 added blank
      '+#if defined(K_MAP_OpCode_Measure_User_Screen)',  // L14909
      '+U32 DrvMTR_MTR::DrvMTR_Get_User_Measure_Screen(T_stHMIMeasureUserScreenlist *pMeasureUserScreenData, U32 u32Opcode)', // L14910
      '+{',                                        // L14911
      '+    if (NULL == pMeasureUserScreenData)',   // L14912
      '+    {',                                    // L14913
      '+        return E_DrvMTR_Ret_Error;',       // L14914
      '+    }',                                    // L14915
      '+    U16 u16ScreenId = M_HMI_Extract_Screen_ID_From_Opcode(u32Opcode);', // L14916
      '+    if (M_SUCCESS != C_HMIScreen_Base::GetInstance().HmiMTR_GetMeasureScreenText(pMeasureUserScreenData, u16ScreenId))', // L14917
      '+    {',                                    // L14918
      '+        return E_DrvMTR_Ret_Error;',       // L14919
      '+    }',                                    // L14920
      '+    return E_DrvMTR_Ret_Success;',         // L14921
      '+}',                                        // L14922
      '+#endif',                                   // L14923
      '+',                                         // L14924
    ].join('\n');

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];

    // AI reports L14906 (`}`) but the real violation is the function signature at L14910
    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 5,
        summary: 'Naming issue.',
        comments: [{
          file: 'src/DrvMTR.cpp',
          line: 14906,
          severity: 'error',
          ruleId: 'NAMING',
          message: "Parameter pointer 'pMeasureUserScreenData' lacks type-encoded prefix",
          codeFragment: 'U32 DrvMTR_MTR::DrvMTR_Get_User_Measure_Screen(T_stHMIMeasureUserScreenlist *pMeasureUserScreenData, U32 u32Opcode)',
        }],
        conclusion: 'Fix naming.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const result = await runReview(diff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // c.line must be corrected to the function signature line, not the brace
    expect(comment.line).toBe(14910);
    // The snippet must contain the function signature
    expect(comment.codeContext).toContain('DrvMTR_Get_User_Measure_Screen');
    // The context window must be anchored near the corrected line
    expect(comment.codeContextStartLine).toBeLessThanOrEqual(14910);
    expect(comment.codeContextStartLine).toBeGreaterThanOrEqual(14908);
  });

  /**
   * Boundary: codeFragment matches a line further than MAX_FALLBACK_DIST (30)
   * from the AI-reported line.  The correction must NOT fire — a false positive
   * match far away would silently move the highlight to an unrelated location.
   * c.line must stay at the AI-reported value.
   */
  it('codeFragment correction is bounded: no shift when fragment is beyond MAX_FALLBACK_DIST', async () => {
    // Build a diff with 40 added lines.  The fragment text appears at line 40,
    // but the AI reports line 1 — distance is 39, beyond the 30-line cap.
    const hunkLines = Array.from({ length: 40 }, (_, i) =>
      i === 39
        ? '+U32 farAwayFunction(T_stHMIMeasureUserScreenlist *pData, U32 opcode)'  // line 40
        : `+  statement_${i};`
    );
    const diff = [
      'diff --git a/src/far.cpp b/src/far.cpp',
      '--- a/src/far.cpp',
      '+++ b/src/far.cpp',
      `@@ -1,0 +1,${hunkLines.length} @@`,
      ...hunkLines,
    ].join('\n');

    const remoteSource = [{ ref: 'main', repo: 'org/repo', mrNumber: 1, type: 'github' as const }];

    (callAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        score: 5,
        summary: 'Issue.',
        comments: [{
          file: 'src/far.cpp',
          line: 1,
          severity: 'error',
          ruleId: 'NAMING',
          message: 'Naming violation',
          // Fragment matches line 40 — 39 lines away, beyond the 30-line cap
          codeFragment: 'U32 farAwayFunction(T_stHMIMeasureUserScreenlist *pData, U32 opcode)',
        }],
        conclusion: 'Fix.',
        tests: [],
      }),
      model: 'test',
      backend: 'test',
    });

    const result = await runReview(diff, baseProfile, remoteSource);
    const comment = result.comments[0];

    // c.line must NOT be shifted to line 40 — the match is too far away
    expect(comment.line).toBe(1);
    // Context should be anchored near the AI-reported line 1
    expect(comment.codeContextStartLine).toBeLessThanOrEqual(3);
  });
});
