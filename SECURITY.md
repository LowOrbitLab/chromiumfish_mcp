# Security Policy

## Reporting a Vulnerability

Privately report vulnerabilities that could expose browser data, proxy credentials, or API keys through a GitHub Security Advisory. Never post real credentials, cookies, access tokens, or exploitable target URLs in a public issue.

## Usage Boundaries

- Use this project only for authorized testing, privacy research, and lawful automation.
- Do not expose the Chromium DevTools port or this MCP server directly to the public internet.
- Keep `evaluate` and the native browser agent disabled by default.
- Treat `--allowed-host` as a top-level navigation guard, not a network egress filter; page assets and subframes may contact other hosts.
- Use a separate, least-privilege browser account with revocable credentials.
- Configure 2Captcha only through `TWOCAPTCHA_API_KEY`, and rotate a key immediately if it appears in logs or chat history.
- Enable `--2captcha-forward-proxy` only when required; it sends the configured proxy address and credentials to 2Captcha.
- Require human confirmation before automating purchases, publishing, deletion, or permission changes.

Security updates are currently provided only for the latest release.
