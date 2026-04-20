// src/__tests__/ruleLoader.test.ts
// Unit tests for RuleLoader YAML parsing and profile loading
// Tests run with Vitest in Node environment (no VS Code host required).
// The vscode module is not imported by RuleLoader directly in the methods
// we are testing (parseYaml / loadAll), so no mock is needed for these tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RuleLoader } from '../ruleLoader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'revvy-test-'));
}

function writeYaml(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

const VALID_YAML = `
profile:
  id: test-profile
  label: "Test Profile"
  description: "A minimal test profile"
  file_patterns:
    - "**/*.ts"
  system_prompt_extra: ""
  rules:
    - id: NO_CONSOLE
      category: coding-standards
      severity: warning
      enabled: true
      title: "No console.log"
      description: "Do not use console.log in production"
    - id: NO_ANY
      category: typing
      severity: error
      enabled: false
      title: "No any type"
      description: "Avoid using the any type"
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuleLoader — parseYaml (via loadAll)', () => {
  let tmpDir: string;
  let logs: string[];
  let loader: RuleLoader;

  beforeEach(() => {
    tmpDir = makeTempDir();
    logs = [];
    loader = new RuleLoader(tmpDir, (msg) => logs.push(msg));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a valid YAML file into a correct ReviewProfile', async () => {
    writeYaml(tmpDir, 'test.yaml', VALID_YAML);

    const profiles = await loader.loadAll();

    expect(profiles).toHaveLength(1);
    const p = profiles[0];
    expect(p.id).toBe('test-profile');
    expect(p.label).toBe('Test Profile');
    expect(p.file_patterns).toEqual(['**/*.ts']);
    expect(p.rules).toHaveLength(2);
    expect(p.rules[0].id).toBe('NO_CONSOLE');
    expect(p.rules[0].severity).toBe('warning');
  });

  it('returns null (and skips the file) when the top-level "profile:" key is missing', async () => {
    writeYaml(tmpDir, 'bad.yaml', `
rules:
  - id: ORPHAN_RULE
    title: "Orphan"
    severity: warning
    enabled: true
    description: "No parent profile key"
`);

    const profiles = await loader.loadAll();

    expect(profiles).toHaveLength(0);
    expect(logs.some((l) => l.includes('YAML parse error'))).toBe(true);
  });

  it('returns null when required fields (id, label, rules) are absent', async () => {
    writeYaml(tmpDir, 'incomplete.yaml', `
profile:
  description: "Missing id, label, and rules"
`);

    const profiles = await loader.loadAll();

    expect(profiles).toHaveLength(0);
    expect(logs.some((l) => l.includes('YAML parse error'))).toBe(true);
  });

  it('skips non-YAML files in the rules directory', async () => {
    writeYaml(tmpDir, 'test.yaml', VALID_YAML);
    // These should all be silently ignored
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# docs');
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'some notes');
    fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}');

    const profiles = await loader.loadAll();

    // Only the one YAML file should be loaded
    expect(profiles).toHaveLength(1);
  });

  it('preserves disabled rules (enabled: false) without stripping them', async () => {
    writeYaml(tmpDir, 'test.yaml', VALID_YAML);

    const profiles = await loader.loadAll();
    const rules = profiles[0].rules;

    const disabledRule = rules.find((r) => r.id === 'NO_ANY');
    expect(disabledRule).toBeDefined();
    expect(disabledRule!.enabled).toBe(false);
  });
});
