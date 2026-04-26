// src/ruleLoader.ts
// Loads review profiles and rules from YAML files

import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

// ────────────────────────────────────────────────────────────────────────────
// Types matching YAML schema
// ────────────────────────────────────────────────────────────────────────────

export interface ReviewRule {
  id: string;
  category?: string;
  severity: 'error' | 'warning' | 'suggestion';
  enabled: boolean;
  title: string;
  description: string;
  pattern?: string;           // Regex pattern to match
  suggestion?: string;         // Fix suggestion
  forbidden_in_context?: string;
}

export interface ProfileMetadata {
  version: string;
  last_modified?: string;
  modified_by?: string;
  changelog?: Array<{
    version: string;
    date: string;
    changes: string[];
  }>;
}

export interface ReviewProfile {
  id: string;
  label: string;
  description: string;
  icon?: string;
  file_patterns: string[];
  system_prompt_extra: string;
  rules: ReviewRule[];
  metadata?: ProfileMetadata;
  
  // NEW: Ticket/Project Requirements
  ticket_context?: {
    raw_requirements?: string;          // Simple: paste entire requirement here
    ticket_id?: string;                 // Optional structured fields
    ticket_description?: string;
    requirements?: string[];
    acceptance_criteria?: string[];
    forbidden_changes?: string[];
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Rule Loader
// ────────────────────────────────────────────────────────────────────────────

export class RuleLoader {
  private profiles: Map<string, ReviewProfile> = new Map();
  private rulesPath: string;
  private logger: (msg: string) => void;

  constructor(rulesPath: string, logger?: (msg: string) => void) {
    this.rulesPath = rulesPath;
    this.logger = logger || console.log;
  }

  /**
   * Load all YAML profiles from the rules directory
   */
  async loadAll(): Promise<ReviewProfile[]> {
    this.profiles.clear();

    if (!fs.existsSync(this.rulesPath)) {
      this.logger(`Rules path does not exist: ${this.rulesPath}`);
      this.logger('Creating default rules folder...');
      await this.createDefaultRules();
    }

    const files = fs.readdirSync(this.rulesPath);
    const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    if (yamlFiles.length === 0) {
      this.logger('No YAML files found, creating defaults...');
      await this.createDefaultRules();
      return this.loadAll(); // Reload after creating defaults
    }

    const errors: string[] = [];

    for (const file of yamlFiles) {
      try {
        const fullPath = path.join(this.rulesPath, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const profile = this.parseYaml(content, file);

        if (profile) {
          this.profiles.set(profile.id, profile);
          this.logger(`Loaded profile: ${profile.label} (${profile.rules.length} rules)`);
        } else {
          errors.push(`${file}: parse/validation error (see Output for details)`);
          this.logger(`Skipped profile file: ${file} (parse/validation failed)`);
        }
      } catch (error: any) {
        const msg = `${file}: ${error.message}`;
        errors.push(msg);
        this.logger(`Failed to load ${file}: ${error.message}`);
      }
    }

    const loaded = Array.from(this.profiles.values());

    // Surface a warning with specifics if any YAML files were skipped.
    if (errors.length > 0) {
      const detail = errors.join('\n');
      vscode.window.showWarningMessage(
        `Revvy: ${errors.length} of ${yamlFiles.length} profile file(s) failed to load. ` +
        `Loaded: ${loaded.map(p => `"${p.id}"`).join(', ') || '(none)'}. ` +
        `Errors:\n${detail}`
      );
    }

    return loaded;
  }

  /**
   * Get a specific profile by ID
   */
  getProfile(id: string): ReviewProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * Get all loaded profiles
   */
  getAllProfiles(): ReviewProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Parse YAML content into ReviewProfile
   */
  private parseYaml(content: string, filename: string): ReviewProfile | null {
    try {
      const data = yaml.load(content) as any;
      
      if (!data.profile) {
        throw new Error('Missing "profile" key in YAML');
      }

      const profile = data.profile;

      // Validate required fields
      if (!profile.id || !profile.label || !profile.rules) {
        throw new Error('Profile must have id, label, and rules');
      }

      return {
        id: profile.id,
        label: profile.label,
        description: profile.description || '',
        icon: profile.icon || '$(code)',
        file_patterns: profile.file_patterns || ['**/*'],
        system_prompt_extra: profile.system_prompt_extra || '',
        rules: (profile.rules || []).map((r: any) => this.parseRule(r)),
        metadata: profile.metadata,
        ticket_context: profile.ticket_context,
      };
    } catch (error: any) {
      this.logger(`YAML parse error in ${filename}: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse a single rule from YAML
   */
  private parseRule(r: any): ReviewRule {
    return {
      id: r.id || 'unknown',
      category: r.category,
      severity: r.severity || 'suggestion',
      enabled: r.enabled !== false, // Default to true
      title: r.title || 'Untitled Rule',
      description: r.description || '',
      pattern: r.pattern,
      suggestion: r.suggestion,
      forbidden_in_context: r.forbidden_in_context,
    };
  }

  /**
   * Create default YAML rule files for common stacks
   */
  private async createDefaultRules(): Promise<void> {
    fs.mkdirSync(this.rulesPath, { recursive: true });

    // Create c-embedded.yaml
    const cEmbeddedYaml = `# C/C++ Embedded Systems Review Profile
profile:
  id: c-embedded
  label: "C/C++ Embedded Systems"
  description: "STM32, FreeRTOS, bare-metal firmware"
  icon: "$(circuit-board)"
  file_patterns:
    - "**/*.c"
    - "**/*.cpp"
    - "**/*.h"
    - "**/*.hpp"

  system_prompt_extra: |
    You are reviewing embedded C/C++ firmware for microcontrollers.
    Focus on:
    - Memory safety (no malloc in ISR, stack usage)
    - ISR safety (volatile, critical sections)
    - Type correctness (U8, U16, U32 instead of int)
    - Pointer NULL checks before dereference
    - HAL/CMSIS API usage

  metadata:
    version: "1.0.0"
    last_modified: "2026-03-08"
    modified_by: "system"

  rules:
    # Type Safety
    - id: use-standard-types
      category: type-safety
      severity: error
      enabled: true
      title: "Use U8/U16/U32 instead of int"
      description: "For embedded systems, use explicit-width types for clarity"
      suggestion: "Replace int with U8, U16, or U32"

    # Pointer Safety
    - id: null-check-required
      category: safety
      severity: error
      enabled: true
      title: "Check NULL before pointer dereference"
      description: "All pointers must be validated before use"
      suggestion: "Add: if (ptr != NULL) { ... }"

    # ISR Safety
    - id: no-malloc-isr
      category: isr-safety
      severity: error
      enabled: true
      title: "No malloc in ISR"
      description: "Dynamic allocation forbidden in interrupt handlers"

    - id: volatile-shared
      category: isr-safety
      severity: error
      enabled: true
      title: "Volatile shared variables"
      description: "Variables shared between ISR and main must be volatile"

    - id: critical-section
      category: isr-safety
      severity: error
      enabled: true
      title: "Critical section guards"
      description: "Shared data access must use critical sections"
      suggestion: "Use taskENTER_CRITICAL / taskEXIT_CRITICAL"

    # HAL/API Usage
    - id: hal-return-check
      category: api-usage
      severity: warning
      enabled: true
      title: "Check HAL return values"
      description: "HAL_xxx() functions must have return value checked"
      suggestion: "if (HAL_xxx() != HAL_OK) { /* handle error */ }"

    - id: no-blocking-isr
      category: isr-safety
      severity: error
      enabled: true
      title: "No blocking calls in ISR"
      description: "No vTaskDelay, HAL_Delay, or mutex waits in interrupts"

    # Coding Standards
    - id: bounds-check
      category: safety
      severity: warning
      enabled: true
      title: "Array bounds checking"
      description: "Array accesses should have explicit bounds validation"

    - id: magic-numbers
      category: maintainability
      severity: suggestion
      enabled: true
      title: "No magic numbers"
      description: "Use named constants instead of hardcoded values"
`;

    // Create yocto.yaml
    const yoctoYaml = `# Yocto/OpenEmbedded Review Profile
profile:
  id: yocto
  label: "Yocto / OpenEmbedded"
  description: "BitBake recipes, layers, kernel config"
  icon: "$(layers)"
  file_patterns:
    - "**/*.bb"
    - "**/*.bbappend"
    - "**/*.bbclass"
    - "**/*.conf"
    - "**/*.inc"

  system_prompt_extra: |
    You are reviewing Yocto/OpenEmbedded build system code.
    Focus on:
    - SRC_URI checksums (md5/sha256)
    - LICENSE field with SPDX identifiers
    - RDEPENDS vs DEPENDS correctness
    - do_install using install command (not cp)
    - Layer compatibility

  metadata:
    version: "1.0.0"
    last_modified: "2026-03-08"

  rules:
    - id: src-uri-checksum
      category: build-system
      severity: error
      enabled: true
      title: "SRC_URI must have checksums"
      description: "All SRC_URI entries need sha256sum and md5sum"

    - id: spdx-license
      category: licensing
      severity: error
      enabled: true
      title: "Use SPDX license identifiers"
      description: "LICENSE field must use valid SPDX identifiers"

    - id: rdepends-vs-depends
      category: dependencies
      severity: warning
      enabled: true
      title: "RDEPENDS vs DEPENDS"
      description: "Runtime deps in RDEPENDS, build deps in DEPENDS"

    - id: do-install-permissions
      category: packaging
      severity: warning
      enabled: true
      title: "Use install command"
      description: "Use install -m instead of cp in do_install"

    - id: layerseries-compat
      category: compatibility
      severity: error
      enabled: true
      title: "LAYERSERIES_COMPAT required"
      description: "layer.conf must declare LAYERSERIES_COMPAT"
`;

    // Create python.yaml
    const pythonYaml = `# Python Review Profile
profile:
  id: python
  label: "Python"
  description: "General Python best practices"
  icon: "$(snake)"
  file_patterns:
    - "**/*.py"

  system_prompt_extra: |
    You are reviewing Python code.
    Focus on type hints, exception handling, and security.

  metadata:
    version: "1.0.0"
    last_modified: "2026-03-08"

  rules:
    - id: type-hints
      category: typing
      severity: warning
      enabled: true
      title: "Type hints required"
      description: "All public functions must have type annotations"

    - id: no-bare-except
      category: exceptions
      severity: error
      enabled: true
      title: "No bare except"
      description: "Always specify exception type"

    - id: no-shell-true
      category: security
      severity: error
      enabled: true
      title: "No shell=True"
      description: "subprocess must not use shell=True with user input"

    - id: context-manager
      category: resources
      severity: warning
      enabled: true
      title: "Use context managers"
      description: "File handles must use with statement"
`;

    fs.writeFileSync(path.join(this.rulesPath, 'c-embedded.yaml'), cEmbeddedYaml);
    fs.writeFileSync(path.join(this.rulesPath, 'yocto.yaml'), yoctoYaml);
    fs.writeFileSync(path.join(this.rulesPath, 'python.yaml'), pythonYaml);

    // Commit-style profile: universal rules for commit message generation.
    // Not a domain profile — never shown in the active profile selector.
    const commitStyleYaml = `# Commit Message Style Profile
# Universal rules that apply to every team regardless of domain.
# Used exclusively for commit message generation — never mixed into code review findings.
profile:
  id: commit-style
  label: "Commit Message Style"
  description: "Universal commit message format rules — applies to all teams"
  icon: "$(git-commit)"
  file_patterns:
    - "**/*"
  system_prompt_extra: ""
  metadata:
    version: "1.0.0"
    last_modified: "2026-04-25"
    modified_by: "system"
  rules:
    - id: commit-conventional-format
      category: commit-message
      severity: error
      enabled: true
      title: "Use conventional commit format"
      description: "Every subject must start with a type prefix: feat|fix|refactor|chore|docs|test|perf|style|ci|build. Optional scope in parens: feat(scope): message."
      suggestion: "e.g. fix(isr): add volatile guard for shared counter flag"

    - id: commit-subject-length
      category: commit-message
      severity: error
      enabled: true
      title: "Subject line ≤72 characters"
      description: "First line must not exceed 72 characters. Use a body paragraph after a blank line for detail."
      suggestion: "Break long descriptions into subject + body separated by a blank line"

    - id: commit-imperative-mood
      category: commit-message
      severity: warning
      enabled: true
      title: "Use imperative mood in subject"
      description: "Write as a command. Correct: 'add null check'. Wrong: 'added null check' or 'adds null check'."

    - id: commit-no-period
      category: commit-message
      severity: suggestion
      enabled: true
      title: "No trailing period on subject line"
      description: "The subject line must not end with a period or other punctuation mark."

    - id: commit-no-vague-words
      category: commit-message
      severity: warning
      enabled: true
      title: "Avoid vague commit words"
      description: "Do not use vague words like 'fix', 'update', 'change', 'misc', 'wip' as the entire subject. Describe WHAT and WHY."
      suggestion: "Be specific: 'fix(sensor): prevent divide-by-zero when sample rate is zero'"
`;
    fs.writeFileSync(path.join(this.rulesPath, 'commit-style.yaml'), commitStyleYaml);

    this.logger('Created default YAML profiles: c-embedded, yocto, python, commit-style');
  }

  /**
   * Watch for YAML file changes and reload
   */
  watchForChanges(callback: () => void): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.rulesPath, '*.{yaml,yml}')
    );

    watcher.onDidChange(() => {
      this.logger('Rules file changed, reloading...');
      this.loadAll().then(callback);
    });

    watcher.onDidCreate(() => {
      this.logger('New rules file detected, reloading...');
      this.loadAll().then(callback);
    });

    watcher.onDidDelete(() => {
      this.logger('Rules file deleted, reloading...');
      this.loadAll().then(callback);
    });

    return watcher;
  }
}
