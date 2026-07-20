# Usage

Detailed usage notes for the browser tools. See the [README](../README.md) for install and configuration.

The browser starts lazily on the first tool call that needs a page, and is cleaned up automatically when the MCP client disconnects.

## Snapshots and element references

`snapshot` lists visible interactive elements and assigns temporary references (`e1`, `e2`, …). A call returns output like:

```text
[e1] input "Search" type=text value=""
[e2] button "Submit"
[e3] input "Remember me" type=checkbox unchecked
[e4] select "Region" selected=["us"]
[e5] link "Documentation" -> https://example.com/docs
```

Pass `e1` to `type_text`, `e2` to `click`, or `e4` to `select_option`. References belong to the latest snapshot of the current page and selected frame — request a new snapshot after the page changes.

`snapshot` reports input type and value, checked/unchecked, selected values, up to 20 dropdown options, expanded/collapsed, and disabled. Password values are never returned. Output defaults to 100 visible elements and 20,000 characters; tune it with `scope`, `maxElements`, and `maxChars`. A truncation marker means more matching elements may exist. Use `select_option` with `matchBy: "value"` or `matchBy: "label"`, and use `set_checked` instead of toggling a checkbox blindly. Radios support `checked: true` only; select another radio to change the choice.

## Text and screenshots

`get_text` reads the first matching `selector` in a page or frame. It returns at most 20,000 characters by default, bounded by both the per-call `maxChars` value and the server's `--max-text-chars` setting.

`take_screenshot` rejects captures larger than 25 million pixels or 20,000 pixels on either axis. Reduce `--window-size`, or capture the viewport instead of the full page, when an image exceeds that budget.

## Frames and form controls

`list_frames` returns a stable `frameId` for each frame in the current page. Bounding boxes are omitted by default; set `includeBox: true` only for coordinate interaction. Pass a frame ID to `snapshot` or `get_text` to inspect that frame. Element references created by a frame snapshot work with `click`, `hover`, `type_text`, `select_option`, `set_checked`, and `wait_for`; when using a CSS selector instead of a reference, pass the same `frameId` to the action. Refresh `list_frames` after navigation because detached child frames receive new IDs.

## Waiting

`wait_for` accepts a typed `condition` object. Supported kinds are `element`, `text`, `url`, `load`, and `time`. Element and text states default to `visible`; URL values support Playwright glob patterns such as `**/dashboard`.

```json
{
  "condition": { "kind": "text", "text": "Complete", "state": "visible" },
  "timeoutMs": 30000
}
```

## Cross-origin challenge widgets

Ordinary frames can be inspected by `frameId`, including cross-origin application frames. DOM access to known Cloudflare challenge frames is intentionally blocked because probing them can reduce clearance rates. For those cases:

1. `navigate` to the target URL
2. `find_challenge` — inspect `present`, `kind`, and `widget`
3. `solve_challenge` — automatic clicks near the widget checkbox region + clearance polling
4. Or `list_frames` + `click_at` for manual coordinate control

`solve_challenge` returns JSON with `ok`, `method`, `attempts`, `widgetState`, `tokenPresent`, `widget`, and `clicks`. Treat `ok: false` as a hard failure and fall back (retry, a different network path, or another interaction strategy). Embedded widgets are confirmed via response token / widget state, not main-document text alone. Results still depend on page structure and environment.

Do **not** read challenge-frame document text or probe `cf-turnstile-response` / `cf-chl-widget*` inputs while still on the gate page; that can collapse interactive clearance rates.

## Native browser agent

An MCP client can normally complete workflows by composing the granular browser tools, so `run_task` is usually unnecessary. To use ChromiumFish's native browser agent, configure an OpenAI-compatible endpoint through these environment variables:

```text
OPENAI_API_KEY
OPENAI_API_BASE
OPENAI_API_MODEL
```

Then start the server with `--allow-native-agent`. This mode forwards the credentials to the local ChromiumFish browser process and enables unattended browser actions. Use it only in a trusted environment.
