# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, please report it via one of the following channels:

1. **GitHub Private Vulnerability Reporting** (preferred):  
   Go to [Security Advisories](https://github.com/YonK0/revvy/security/advisories/new) and open a private advisory.

2. **Email**: Open an issue with the label `security` and we will contact you privately.

### What to include

- A clear description of the vulnerability
- Steps to reproduce the issue
- Potential impact (e.g., credential leak, code execution, data exposure)
- Any suggested fix, if you have one

### What to expect

- **Acknowledgement** within 48 hours
- **Status update** within 7 days
- We will work with you on a coordinated disclosure timeline

## Security Considerations for Users

### API Keys
- Never commit API keys to your repository
- Set keys via Command Palette: `Revvy: Set OpenAI API Key` or `Revvy: Set Anthropic API Key`
- Keys are stored in your OS keychain via VS Code's SecretStorage API (macOS Keychain, Windows Credential Manager, Linux libsecret) — they never appear in settings.json or any plaintext file
- To remove stored keys: `Revvy: Clear All API Keys`
- For team/enterprise use, prefer GitHub Copilot (no personal API key required)

### MCP Server Tokens
- The `.vscode/mcp.json` file uses VS Code's `promptString` inputs — tokens are prompted at runtime and never stored on disk
- Never replace `${input:...}` references with hardcoded token values
- Treat your GitHub/GitLab/Atlassian tokens as passwords — use the minimum required scopes

### YAML Rule Profiles
- Rule profiles (`.vscode-reviewer/profiles/*.yaml`) are local configuration files
- They may contain `ticket_context` data fetched from Jira — do not commit profiles with sensitive ticket data to public repositories
- Add your profiles folder to `.gitignore` if it may contain sensitive context

### WebView Security
- The extension's WebView panel uses VS Code's sandboxed WebView environment
- All user-provided content is HTML-escaped before rendering
- File content is read from the workspace and rendered as syntax-highlighted code only
