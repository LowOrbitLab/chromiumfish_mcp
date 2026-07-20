# Security Policy

## Reporting a Vulnerability

Privately report vulnerabilities that could expose browser data, proxy credentials, or API keys through a GitHub Security Advisory. Never post real credentials, cookies, access tokens, or exploitable target URLs in a public issue.

## Usage Boundaries

- Use this project only for authorized testing, privacy research, and lawful automation.
- Do not expose the Chromium DevTools port or this MCP server directly to the public internet.
- Keep `evaluate` and the native browser agent disabled by default.
- Treat `--allowed-host` as a top-level navigation guard, not a network egress filter; page assets and subframes may contact other hosts.
- Use a separate, least-privilege browser account with revocable credentials.
- Require human confirmation before automating purchases, publishing, deletion, or permission changes.

Security updates are currently provided only for the latest release.
