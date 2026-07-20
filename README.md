# chromiumfish_mcp

`chromiumfish_mcp` is an independent Model Context Protocol (MCP) server for [ChromiumFish](https://github.com/arman-bd/chromiumfish). It lets Claude Code, Claude Desktop, Cursor, and other MCP clients drive a ChromiumFish browser through structured tools.

It uses the official ChromiumFish npm package and ships no Chromium source or binaries — on the first tool call that needs a page, the upstream SDK downloads and caches the matching browser build. See **[docs/USAGE.md](docs/USAGE.md)** for detailed tool usage.

## Requirements

- Node.js 20 or later.
- An OS and architecture supported by ChromiumFish.
- Network access for the initial browser download. If no prebuilt asset matches your platform, build ChromiumFish locally and point to it with `--chrome-path` or `CHROME_BIN`.

## Install

```bash
npm install --global github:LowOrbitLab/chromiumfish_mcp
chromiumfish_mcp --persona-seed alice
```

Or run without installing: `npx --yes github:LowOrbitLab/chromiumfish_mcp --persona-seed alice`.

## Configure

Add the server to your MCP client config:

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

To run from GitHub instead of a global install, set `"command": "npx"` and prepend `"--yes", "github:LowOrbitLab/chromiumfish_mcp"` to `args`. On Windows, use `npx.cmd` if your client cannot resolve `npx`.

## Tools

| Tool | Purpose |
|------|---------|
| `list_pages`, `open_page`, `select_page`, `close_page` | Manage pages by stable `pageId` |
| `navigate`, `navigate_back`, `navigate_forward`, `reload` | Navigate and use page history |
| `snapshot` | List visible interactive elements with `e1`/`e2` references |
| `get_text`, `take_screenshot` | Retrieve page or frame content |
| `click`, `hover`, `type_text`, `select_option`, `set_checked`, `press_key`, `scroll`, `wait_for` | Interact with the page |
| `click_at` | Click absolute coordinates (for widgets `snapshot` cannot see) |
| `list_frames` | List frames/iframes with stable IDs |
| `find_challenge`, `solve_challenge` | Detect and clear interstitial / framed challenges |
| `evaluate` | Run arbitrary JavaScript — requires `--allow-eval` |
| `run_task` | Native ChromiumFish agent — requires `--allow-native-agent` |

Snapshot references, frame-aware interaction, waiting, and the cross-origin challenge workflow are covered in **[docs/USAGE.md](docs/USAGE.md)**.

## Command-line options

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

Proxy credentials can be embedded in the proxy URL, but are then exposed in the client config. Never commit config files containing proxy passwords, cookies, or API keys.

## Security

- stdio only — do not expose the Chromium DevTools endpoint to the public internet.
- `evaluate` and the native agent are disabled by default; enable them only in trusted environments.
- `--allowed-host example.com` restricts top-level HTTP/HTTPS navigation (redirects, links, form posts, popups) to a host and its subdomains. Third-party subframes and page assets remain reachable — it is a navigation guard, not a network egress filter.
- Clients can click and type with real side effects. Keep human confirmation for purchases, publishing, deletion, and permission changes.
- Each process runs an independent browser context; this is not a shared multi-tenant service.

## Development

```bash
npm ci
npm test
node dist/index.js --help
```

The suite uses an in-memory MCP transport to verify tool discovery, dangerous-tool opt-in, and results. It does not download or launch a browser.

## License

MIT. ChromiumFish code and trademarks belong to their respective contributors; see [NOTICE](NOTICE) for attribution. This is an independent wrapper, not an official ChromiumFish release.
