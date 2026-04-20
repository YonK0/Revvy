# Contributing to Revvy

Thank you for your interest in contributing! This document explains how to get started, what we are looking for, and how to submit your changes.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Submitting Changes](#submitting-changes)
- [Writing Rule Profiles](#writing-rule-profiles)
- [Adding AI Backends](#adding-ai-backends)
- [Commit Message Style](#commit-message-style)
- [Review Process](#review-process)

---

## Code of Conduct

Be respectful. Constructive criticism is welcome; personal attacks are not. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) spirit.

---

## Ways to Contribute

You do not need to write code to contribute:

- **New rule profiles** — the most impactful contribution; add a YAML profile for a new language, framework, or domain (Rust, Go, React, security hardening, MISRA C, etc.)
- **Bug reports** — open an issue with steps to reproduce
- **Feature requests** — open an issue describing the use case
- **Documentation** — improve the README, add examples, fix typos
- **Bug fixes** — pick up an issue labeled `good first issue` or `bug`
- **New AI backends** — add support for Gemini, Ollama, Azure OpenAI, etc.
- **UI improvements** — improve the WebView panel experience

---

## Development Setup

### Prerequisites

- Node.js 18+ and npm
- VS Code 1.96+
- Git

### Steps

```bash
# 1. Fork and clone the repository
git clone https://github.com/Yonk0/revvy.git
cd revvy

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run compile

# 4. Open in VS Code
code .

# 5. Launch the Extension Development Host
# Press F5, or go to Run > Start Debugging
```

The Extension Development Host opens a new VS Code window with your local version of the extension loaded.

### Watch mode (recommended for active development)

```bash
npm run watch
```

This recompiles TypeScript automatically on every file save. You still need to reload the Extension Development Host window (`Ctrl+R` / `Cmd+R` inside the dev window) to pick up changes.

### Type-checking without compiling

```bash
npm run typecheck
```

---

## Project Structure

```
src/
├── extension.ts       # Entry point — activate(), command registrations, git operations
├── panelProvider.ts   # WebView UI provider — HTML generation, message handling
├── reviewer.ts        # Core review engine — prompt building, AI call, response parsing
├── aiBackend.ts       # AI backend abstraction — Copilot, OpenAI, Anthropic, fallback chain
└── ruleLoader.ts      # YAML loader — file scanning, profile parsing, live-reload watcher

.vscode-reviewer/
└── profiles/          # Example YAML rule profiles (shipped with extension)

.github/
├── workflows/         # CI/CD (GitHub Actions)
├── ISSUE_TEMPLATE/    # Issue templates
└── pull_request_template.md
```

### Key interfaces (defined in `src/reviewer.ts`)

```typescript
interface ReviewComment {
  file: string;
  line: number;
  endLine?: number;
  severity: 'error' | 'warning' | 'info';
  ruleId?: string;
  ruleTitle?: string;
  message: string;
  suggestion?: string;
}

interface ReviewResult {
  verdict: string;
  score: number;           // 1–10
  summary: string;
  comments: ReviewComment[];
  conclusion: string;
  tests: ReviewTest[];
  profileUsed: string;
  modelUsed: string;
  backendUsed: string;
  durationMs: number;
}
```

---

## Submitting Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   # or
   git checkout -b fix/issue-123
   ```

2. **Make your changes** — keep commits focused and atomic.

3. **Type-check** before pushing:
   ```bash
   npm run typecheck
   ```

4. **Open a Pull Request** against `main`.  
   Fill in the PR template — describe what changed and why.

5. **CI must pass** — the GitHub Actions workflow runs `npm run compile` on every PR.

---

## Writing Rule Profiles

Rule profiles are the most valuable contribution. They let teams enforce domain-specific standards without changing any code.

### File location

Add your profile to `.vscode-reviewer/profiles/your-profile.yaml`.

### Minimal valid profile

```yaml
profile:
  id: my-profile           # Must be unique; used in settings
  label: "My Profile"      # Displayed in the UI
  version: "1.0.0"
  file_patterns:
    - "**/*.ts"

  rules:
    - id: RULE_001
      title: "Short descriptive title"
      category: "coding-standards"
      severity: warning    # error | warning | info
      enabled: true
      description: |
        Explain what this rule checks and why it matters.
        Be specific — the AI uses this text verbatim in its system prompt.
```

### Guidelines for good rules

- **Be specific in `description`** — vague descriptions produce vague AI feedback
- **One concern per rule** — don't combine unrelated checks
- **Use meaningful `id` prefixes** — group related rules (e.g., `SEC_001`, `SEC_002` for security)
- **Test your profile** — run a review against real code and verify the AI cites your rules
- **Include a `system_prompt_extra`** for domain-specific context the AI needs (e.g., "This is safety-critical firmware. Memory allocation after init is forbidden.")

### Naming conventions for profile files

Use lowercase kebab-case: `rust-async.yaml`, `react-hooks.yaml`, `misra-c.yaml`.

---

## Adding AI Backends

New backends go in `src/aiBackend.ts`. The interface is simple:

```typescript
// 1. Add a new async function
async function callMyBackend(
  userPrompt: string,
  systemPrompt: string,
  apiKey: string
): Promise<string> {
  // Make the API call, return the full response text
}

// 2. Add it to the fallback chain in callAI()
// 3. Add a new enum value to the aiBackend setting in package.json
// 4. Add the API key setting if needed
```

---

## Commit Message Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Rust rule profile
fix: handle empty git diff gracefully
docs: add MCP server setup instructions
chore: remove unused simple-git dependency
refactor: split panelProvider into smaller modules
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

---

## Review Process

- All PRs are reviewed by at least one maintainer
- We aim to respond within 48 hours
- Small, focused PRs are reviewed faster than large ones
- Rule profile contributions are generally merged quickly if they follow the guidelines above

---

Thank you for contributing!
