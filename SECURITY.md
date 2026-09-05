# Security Policy

## Reporting a Vulnerability

Privately report vulnerabilities that could expose browser data, proxy credentials, or API keys through a GitHub Security Advisory. Never post real credentials, cookies, access tokens, or exploitable target URLs in a public issue.

## Usage Boundaries

- Use this project only for authorized testing, privacy research, and lawful automation.
- Do not expose the Chromium DevTools port or this MCP server directly to the public internet.
- Keep `evaluate` and the native browser agent disabled by default.
- Treat `--allowed-host` as a top-level navigation guard, not a network egress filter; page assets and subframes may contact other hosts. It also enables request interception, which disables the browser's HTTP cache for that session.
- With the navigation allowlist enabled, Service Workers are disabled and redirect destinations are checked at Chromium's response-header stage. A failed check aborts the redirect; a page on which interception cannot be established is closed.
- Page actions in one session run serially, and an MCP request cancelled while queued never runs. A failed follow-up snapshot is reported separately as `snapshotError` and is never grounds for repeating an action that may have side effects.
- `--allow-native-agent` forwards `OPENAI_API_KEY` to the browser as a command-line argument, where any local process that can list command lines is able to read it. Use a key scoped to this purpose and revoke it rather than sharing one with other systems, and keep the flag off on multi-user machines.
- Use a separate, least-privilege browser account with revocable credentials.
- Require human confirmation before automating purchases, publishing, deletion, or permission changes.

Security updates are currently provided only for the latest release.
