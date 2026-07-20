# chromiumfish_mcp

`chromiumfish_mcp` is an independent Model Context Protocol (MCP) server for [ChromiumFish](https://github.com/arman-bd/chromiumfish). It lets Claude Code, Claude Desktop, Cursor, and other MCP clients control a ChromiumFish browser through structured tools.

This project uses the official ChromiumFish npm package. It does not include Chromium source code or browser binaries. On the first browser tool call, the upstream SDK downloads the matching browser build and caches it by version.

## Features

- MCP over stdio for local desktop clients and development tools.
- Lazy browser startup and automatic cleanup when the MCP client disconnects.
- Multi-page management: create, select, list, and close pages.
- Snapshot references such as `e1` and `e2` for reliable interaction with the current page state.
- Navigation, text extraction, screenshots, clicking, typing, key presses, scrolling, and waits.
- Coordinate clicks, frame listing, and helpers for interacting with cross-origin framed widgets that `snapshot` cannot see.
- ChromiumFish persona seeds, proxies, window sizes, browser versions, and time zones.
- `eval_js` and the native browser agent are disabled by default and require explicit opt-in.
- Optional navigation host allowlists and text output limits.

## Requirements

- Node.js 20 or later.
- An operating system and architecture supported by ChromiumFish.
- Network access for the initial ChromiumFish browser download.

Automatic download depends on the upstream ChromiumFish release containing an asset for your platform. If no matching asset is available, build ChromiumFish locally and use `--chrome-path` or `CHROME_BIN` to point to the executable.

## Installation

Install directly from GitHub:

```bash
npm install --global github:LowOrbitLab/chromiumfish_mcp
```

Then start the server:

```bash
chromiumfish_mcp --persona-seed alice
```

You can also run it without a global installation:

```bash
npx --yes github:LowOrbitLab/chromiumfish_mcp --persona-seed alice
```

## MCP Client Configuration

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

Running directly from GitHub:

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

On Windows, use `npx.cmd` as the command if your MCP client cannot resolve `npx`.

## Tools

- `browser_status`: report lazy startup state, page count, and the current page.
- `list_pages`, `new_page`, `select_page`, `close_page`: manage browser pages.
- `navigate`, `go_back`: navigate and use page history.
- `snapshot`: list visible interactive elements and create temporary references.
- `get_text`, `screenshot`: retrieve page content.
- `click`, `type_text`, `press_key`, `scroll`, `wait_for`: interact with the page.
- `mouse_click`: click at absolute page coordinates (for cross-origin widgets invisible to `snapshot`).
- `list_frames`: list frames/iframes with URLs; bounding boxes included by default (`includeBox: false` for a faster URL-only listing).
- `find_challenge`: detect common interstitial / framed-challenge page states for text-only agents (`present`, `kind`, `widgetState`, `tokenPresent`, `widget`).
- `click_challenge`: humanized coordinate clicks on standard checkbox widgets inside cross-origin challenge frames, then poll until clearance is confirmed (token / widget state / interstitial exit). Concurrent calls return `method: "busy"`.
- `eval_js`: execute arbitrary JavaScript; available only with `--allow-eval`.
- `run_task`: use the native ChromiumFish browser agent; available only with `--allow-native-agent`.

### Cross-origin framed widgets

Some embedded controls live in cross-origin iframes and never appear in `snapshot`. For those cases:

1. `navigate` to the target URL
2. `find_challenge` — inspect `present`, `kind`, and `widget`
3. `click_challenge` — automatic clicks near the widget checkbox region + clearance polling
4. Or `list_frames` + `mouse_click` for manual coordinate control

`click_challenge` returns JSON with `ok`, `method`, `attempts`, `widgetState`, `tokenPresent`, `widget`, and `clicks`. Treat `ok: false` as a hard failure and fall back (retry, different network path, or another interaction strategy). Embedded widgets are confirmed via response token / widget state, not main-document text alone. Results still depend on page structure and environment.

Do **not** read challenge-frame document text or probe `cf-turnstile-response` / `cf-chl-widget*` inputs while still on the gate page — that can collapse interactive clearance rates.

A `snapshot` call returns output similar to this:

```text
[e1] input "Search"
[e2] button "Submit"
[e3] link "Documentation" -> https://example.com/docs
```

Pass `e1` to `type_text` or `e2` to `click`. Element references belong to the latest snapshot of the current page. Request a new snapshot after the page changes.

## Command-Line Options

```text
--persona-seed VALUE       Use a stable browser fingerprint persona
--chrome-path PATH         Use a local ChromiumFish executable
--browser-version VERSION  Select an upstream ChromiumFish build version
--headed                   Show the browser window
--window-size WIDTHxHEIGHT Set the browser window size
--timezone ZONE            Use an IANA time zone or auto
--proxy URL                Route browser traffic through a proxy
--allowed-host HOST        Allow navigation to a host and its subdomains; repeatable
--max-text-chars N         Limit the number of characters returned by get_text
--allow-eval               Enable arbitrary JavaScript execution
--allow-native-agent       Enable the native ChromiumFish browser agent
```

Proxy credentials can be embedded in the proxy URL, but doing so exposes them in the MCP client configuration. Never commit configuration files containing proxy passwords, cookies, or API keys.

## Native Browser Agent

An MCP client can normally complete workflows by composing the granular browser tools, so `run_task` is usually unnecessary. To use ChromiumFish's native browser agent, configure an OpenAI-compatible endpoint through these environment variables:

```text
OPENAI_API_KEY
OPENAI_API_BASE
OPENAI_API_MODEL
```

Then start the server with `--allow-native-agent`. This mode forwards the credentials to the local ChromiumFish browser process and enables unattended browser actions. Use it only in a trusted environment.

## Security Boundaries

- The server supports stdio only. Do not expose the Chromium DevTools endpoint to the public internet.
- `eval_js` is disabled by default because it can read or modify any data available to the page.
- Use `--allowed-host example.com` to limit navigation to a host and its subdomains.
- MCP clients can click and type, which may cause external side effects. Keep human confirmation for purchases, publishing, deletion, and permission changes.
- Each MCP process maintains an independent browser context. This server is not designed as a shared multi-tenant service.

## Local Development

```bash
npm ci
npm test
node dist/index.js --help
```

The test suite uses an in-memory MCP transport to verify tool discovery, dangerous-tool opt-in, and tool results. It does not download or launch a browser.

## License and Attribution

This project is licensed under the MIT License. ChromiumFish code and trademarks belong to their respective project contributors; see [NOTICE](NOTICE) for attribution. This is an independent wrapper and is not an official ChromiumFish release.
