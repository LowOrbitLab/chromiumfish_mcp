# Security policy

## Reporting a vulnerability

Report vulnerabilities that could leak browser data, proxy credentials, or API keys privately through a GitHub Security Advisory. Never post real credentials, cookies, access tokens, or exploitable target addresses in a public issue.

## Usage boundaries

- Use this project only for authorized testing, privacy research, and lawful automation.
- Do not expose the Chromium DevTools port or this MCP server directly to the public internet.
- Keep `eval_js` and the built-in browser agent disabled by default.
- Use a separate, least-privilege browser account with revocable credentials.
- Require human confirmation before automating purchases, publishing, deletions, or permission changes.

Security updates are currently provided only for the latest release.
