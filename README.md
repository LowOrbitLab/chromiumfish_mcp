# chromiumfish_mcp

`chromiumfish_mcp` is an independent Model Context Protocol (MCP) server for [ChromiumFish](https://github.com/arman-bd/chromiumfish). It lets Claude Code, Claude Desktop, Cursor, and other MCP clients control the ChromiumFish browser through structured tools.

This project reuses the official ChromiumFish npm package and contains no Chromium source or browser binaries. The upstream SDK downloads the browser on the first browser tool call and caches it per version.

## Features

- MCP stdio transport, suited to local desktop and developer tools.
- The browser launches on demand and is cleaned up when the MCP client disconnects.
- Multi-page management: create, switch, list, and close pages.
- Snapshot element references: use `e1`, `e2` to act on elements in the current snapshot.
- Tools for navigation, page text, screenshots, clicking, typing, key presses, scrolling, and waiting.
- Supports ChromiumFish persona seed, proxy, window size, and time zone.
- `eval_js` and the built-in browser agent are not registered by default and must be enabled explicitly.
- Configurable navigation host allowlist and text output limit.

## Requirements

- Node.js 20 or later.
- An operating system and hardware architecture currently supported by ChromiumFish.
- The first launch needs network access to download a ChromiumFish browser build.

The automatic download depends on whether the upstream ChromiumFish release provides a build asset for the current platform. If it does not, build ChromiumFish yourself and point `--chrome-path` or `CHROME_BIN` at the executable.

## Installation

Install from GitHub:

```bash
npm install --global github:LowOrbitLab/chromiumfish_mcp
```

After installing, run:

```bash
chromiumfish_mcp --persona-seed alice
```

Or run it without a global install:

```bash
npx --yes github:LowOrbitLab/chromiumfish_mcp --persona-seed alice
```

## MCP client configuration

Using the globally installed command:

```json
{
  "mcpServers": {
    "chromiumfish": {
      "command": "chromiumfish_mcp",
      "args": ["--persona-seed", "alice"]
    }
  }
}
```

Run directly from GitHub:

```json
{
  "mcpServers": {
    "chromiumfish": {
      "command": "npx",
      "args": [
        "--yes",
        "github:LowOrbitLab/chromiumfish_mcp",
        "--persona-seed",
        "alice"
      ]
    }
  }
}
```

If a Windows client cannot resolve `npx`, change `command` to `npx.cmd`.

## Tools

- `browser_status`: query the lazy-launch state.
- `list_pages`, `new_page`, `select_page`, `close_page`: manage pages.
- `navigate`, `go_back`: navigation and history.
- `snapshot`: read interactive elements and produce temporary references.
- `get_text`, `screenshot`: read page content.
- `click`, `type_text`, `press_key`, `scroll`, `wait_for`: perform page actions.
- `eval_js`: arbitrary JavaScript, available only with `--allow-eval`.
- `run_task`: the ChromiumFish built-in browser agent, available only with `--allow-native-agent`.

Calling `snapshot` returns a result like this:

```text
[e1] input "Search"
[e2] button "Submit"
[e3] link "Docs" -> https://example.com/docs
```

Pass `e1` to `type_text`, or `e2` to `click`. Element references belong only to the latest snapshot of the current page; call `snapshot` again after the page changes.

## Startup options

```text
--persona-seed VALUE       Pin the browser fingerprint persona
--chrome-path PATH         Use a local ChromiumFish executable
--browser-version VERSION  Upstream browser build version
--headed                  Show the browser window
--window-size WIDTHxHEIGHT Window size
--timezone ZONE           IANA time zone or auto
--proxy URL               Browser proxy
--allowed-host HOST       Navigation host allowlist; repeatable
--max-text-chars N        Maximum characters of page text
--allow-eval              Enable arbitrary JavaScript
--allow-native-agent      Enable the built-in browser agent
```

Proxy credentials can go in the proxy URL, but that puts them in the MCP client configuration. Never commit configuration files containing proxy passwords, cookies, or API keys.

## Built-in browser agent

An MCP client can already compose the fine-grained browser tools, so `run_task` is usually unnecessary. When you do need ChromiumFish's built-in browser agent, provide an OpenAI-compatible endpoint through environment variables:

```text
OPENAI_API_KEY
OPENAI_API_BASE
OPENAI_API_MODEL
```

Then add `--allow-native-agent`. This mode hands the key to the local ChromiumFish browser process and enables unattended operation, so use it only in a trusted environment.

## Security boundaries

- The server speaks stdio only; never expose the Chromium DevTools port directly to the public internet.
- `eval_js` is off by default because it can read or modify any data on the page.
- Use `--allowed-host example.com` to restrict navigation; subdomains are allowed too.
- MCP clients can click and type, which may cause external side effects; keep a human confirmation step for purchases, publishing, or deleting data.
- Each MCP process keeps its own browser context and is not meant for multi-tenant sharing.

## Local development

```bash
npm ci
npm test
node dist/index.js --help
```

The unit tests use an in-memory MCP transport to verify tool discovery, the dangerous-tool switches, and call results, without downloading or launching a browser.

## License and attribution

This project is licensed under MIT. ChromiumFish code and the ChromiumFish name belong to the original project's contributors; see [NOTICE](NOTICE). This project is an independent wrapper, not an official ChromiumFish release.
