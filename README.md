# chromiumfish_mcp

`chromiumfish_mcp` is an independent Model Context Protocol (MCP) server for [ChromiumFish](https://github.com/arman-bd/chromiumfish). It lets Claude Code, Claude Desktop, Cursor, and other MCP clients control a ChromiumFish browser through structured tools.

This project uses the official ChromiumFish npm package. It does not include Chromium source code or browser binaries. On the first tool call that needs an active page, the upstream SDK downloads the matching browser build and caches it by version.

## Features

- MCP over stdio for local desktop clients and development tools.
- Lazy browser startup and automatic cleanup when the MCP client disconnects.
- Multi-page management: create, select, list, and close pages.
- Snapshot references such as `e1` and `e2` for reliable interaction with the current page state.
- Navigation, text extraction, screenshots, clicking, typing, key presses, scrolling, and waits.
- Coordinate clicks, frame listing, and helpers for interacting with cross-origin framed widgets that `snapshot` cannot see.
- ChromiumFish persona seeds, proxies, window sizes, browser versions, and time zones.
- `evaluate` and the native browser agent are disabled by default and require explicit opt-in.
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

- `list_pages`: report lazy startup state and list open pages without starting the browser.
- `open_page`, `select_page`, `close_page`: manage browser pages using stable `pageId` values.
- `navigate`, `navigate_back`, `navigate_forward`, `reload`: navigate and use page history.
- `snapshot`: list visible interactive elements, form state, and temporary references in the main document or a frame.
- `get_text`, `take_screenshot`: retrieve page or frame content.
- `click`, `hover`, `type_text`, `select_option`, `set_checked`, `press_key`, `scroll`, `wait_for`: interact with the page.
- `click_at`: click at absolute page coordinates (for cross-origin widgets invisible to `snapshot`).
- `list_frames`: list frames/iframes with stable IDs, parent relationships, URLs, and optional bounding boxes.
- `find_challenge`: detect common interstitial / framed-challenge page states for text-only agents (`present`, `kind`, `widgetState`, `tokenPresent`, `widget`).
- `solve_challenge`: humanized coordinate clicks on standard checkbox widgets inside cross-origin challenge frames, then poll until clearance is confirmed (token / widget state / interstitial exit). Concurrent calls return `method: "busy"`.
- `evaluate`: execute arbitrary JavaScript; available only with `--allow-eval`.
- `run_task`: use the native ChromiumFish browser agent; available only with `--allow-native-agent`.

### Frames and form controls

`list_frames` returns a stable `frameId` for each frame in the current page. Bounding boxes are omitted by default; set `includeBox: true` only for coordinate interaction. Pass a frame ID to `snapshot` or `get_text` to inspect that frame. Element references created by a frame snapshot work with `click`, `hover`, `type_text`, `select_option`, `set_checked`, and `wait_for`; when using a CSS selector instead of a reference, pass the same `frameId` to the action. Refresh `list_frames` after navigation because detached child frames receive new IDs.

`snapshot` reports relevant state such as input type and value, checked/unchecked, selected values, up to 20 dropdown options, expanded/collapsed, and disabled. Password values are never returned. Output defaults to 100 visible elements and 20,000 characters; use `scope`, `maxElements`, and `maxChars` to tune it. A truncation marker means more matching elements may exist. Use `select_option` with `matchBy: "value"` or `matchBy: "label"`, and use `set_checked` instead of toggling a checkbox blindly. Radios support `checked: true` only; select another radio to change the choice.

`get_text` reads the first matching `selector` in a page or frame. It returns at most 20,000 characters by default, bounded by both the per-call `maxChars` value and the server's `--max-text-chars` setting.

`take_screenshot` rejects captures larger than 25 million pixels or 20,000 pixels on either axis. Reduce `--window-size` or use a viewport capture when a full-page image exceeds that budget.

`wait_for` accepts a typed `condition` object. Supported kinds are `element`, `text`, `url`, `load`, and `time`. Element and text states default to `visible`; URL values support Playwright glob patterns such as `**/dashboard`.

```json
{
  "condition": { "kind": "text", "text": "Complete", "state": "visible" },
  "timeoutMs": 30000
}
```

### Cross-origin challenge widgets

Ordinary frames can be inspected by `frameId`, including cross-origin application frames. DOM access to known Cloudflare challenge frames is intentionally blocked because probing them can reduce clearance rates. For those cases:

1. `navigate` to the target URL
2. `find_challenge` -- inspect `present`, `kind`, and `widget`
3. `solve_challenge` -- automatic clicks near the widget checkbox region + clearance polling
4. Or `list_frames` + `click_at` for manual coordinate control

`solve_challenge` returns JSON with `ok`, `method`, `attempts`, `widgetState`, `tokenPresent`, `widget`, and `clicks`. Treat `ok: false` as a hard failure and fall back (retry, different network path, or another interaction strategy). Embedded widgets are confirmed via response token / widget state, not main-document text alone. Results still depend on page structure and environment.

Do **not** read challenge-frame document text or probe `cf-turnstile-response` / `cf-chl-widget*` inputs while still on the gate page; that can collapse interactive clearance rates.

A `snapshot` call returns output similar to this:

```text
[e1] input "Search" type=text value=""
[e2] button "Submit"
[e3] input "Remember me" type=checkbox unchecked
[e4] select "Region" selected=["us"]
[e5] link "Documentation" -> https://example.com/docs
```

Pass `e1` to `type_text`, `e2` to `click`, or `e4` to `select_option`. Element references belong to the latest snapshot of the current page and selected frame. Request a new snapshot after the page changes.

## Command-Line Options

```text
--persona-seed VALUE       Use a stable browser fingerprint persona
--chrome-path PATH         Use a local ChromiumFish executable
--browser-version VERSION  Select an upstream ChromiumFish build version
--headed                   Show the browser window
--window-size WIDTHxHEIGHT Set the browser window size
--timezone ZONE            Use an IANA time zone or auto
--proxy URL                Route browser traffic through a proxy
--allowed-host HOST        Allow top-level navigation to a host and its subdomains; repeatable
--max-text-chars N         Set the hard limit for text and snapshot output
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
- `evaluate` is disabled by default because it can read or modify any data available to the page.
- Use `--allowed-host example.com` to restrict top-level HTTP/HTTPS navigation to a host and its subdomains. This covers redirects, link clicks, form submissions, and popups; third-party subframes and page assets remain available.
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
