# Changelog

All notable changes to Revvy are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Conventional Commits](https://www.conventionalcommits.org/).

---

## [1.0.1] — 2026-04-04

### Fixed
- **Runtime crash on activation** — switched build pipeline from `tsc` to `esbuild`. The `js-yaml` dependency is now bundled directly into `out/extension.js`, eliminating the `Cannot find module 'js-yaml'` error that caused the webview panel to hang on an infinite spinner.
- Moved `js-yaml` from `dependencies` to `devDependencies` (no longer a runtime requirement).
- Excluded source maps (`out/**/*.map`) from the VSIX package.
- Updated CI workflow to verify the single esbuild output file instead of individual `tsc` outputs.

---

## [1.0.0] — 2026-04-04

### Initial open source release

This is the first public release of Revvy, refactored and cleaned up from the internal development version.

#### Features
- **Rule-driven AI code review** — enforce team standards via YAML rule profiles
- **Multi-backend AI support** — GitHub Copilot, OpenAI GPT-4o, Anthropic Claude with automatic fallback
- **Multi-profile support** — switch between domain-specific profiles per project
- **Auto-profile detection** — automatically selects profile based on file extension
- **YAML live-reload** — rule profiles are reloaded automatically on file save
- **Multi-repo PR/MR review** — review GitHub PRs and GitLab MRs together in one AI pass via MCP servers
- **Jira / ticket integration** — fetch requirements from Jira via Atlassian MCP server and include them in the review prompt
- **Inline results panel** — syntax-highlighted review comments with click-to-navigate
- **Export as Markdown** — one-click export as agent-ready Markdown report
- **Copilot model selector** — pick specific Copilot model from the sidebar UI
- **Integration test generation** — AI generates test scenarios from code changes

#### Bundled rule profiles
- `c-embedded.yaml` — 20 rules for safety-critical C/C++ (type safety, ISR safety, API usage, security)
- `yocto.yaml` — 5 rules for Yocto/OpenEmbedded build recipes
- `python.yaml` — 4 rules for Python best practices

---

## Older versions (pre-open-source)

Versions 0.x – 1.0.61 were internal development iterations and are not documented here.
The `1.0.0` release above represents the clean open source baseline.

---

<!-- Template for future releases:

## [x.y.z] — YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Removed
- ...

-->
