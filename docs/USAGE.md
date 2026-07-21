# Usage

Detailed usage notes for the browser tools. See the [README](../README.md) for install and configuration.

The browser starts lazily on the first tool call that needs a page, and is cleaned up automatically when the MCP client disconnects.

## Snapshots and element references

`snapshot` lists visible interactive elements and assigns temporary references (`e1`, `e2`, ...). A call returns output like:

```text
[e1] input "Search" type=text value=""
[e2] button "Submit"
[e3] input "Remember me" type=checkbox unchecked
[e4] select "Region" selected=["us"]
[e5] link "Documentation" -> https://example.com/docs
```

Pass `e1` to `type_text`, `e2` to `click`, or `e4` to `select_option`. References belong to the latest snapshot of the current page and selected frame; request a new snapshot after the page changes.

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

## 2Captcha 验证码流程

普通跨域应用 frame 仍可通过 `frameId` 检查。reCAPTCHA、hCaptcha 和 Cloudflare challenge frame 的直接 DOM 访问会被阻止，验证码应使用以下流程：

1. 使用 `navigate` 打开目标页面。
2. 调用 `find_challenge`，检查 `present`、`provider`、`kind`、`siteKey` 与 `canSolve`。
3. 调用 `solve_challenge`。服务会向 2Captcha 提交任务、轮询结果、写入响应字段并调用页面注册的 widget 回调。
4. 根据 `ok` 与 `tokenPresent` 判断结果，再继续页面操作。

`solve_challenge` 接受以下参数：

- `timeoutMs`：10 秒到 10 分钟，默认 120 秒。
- `action`：覆盖自动提取的 reCAPTCHA v3 或 Turnstile action。
- `minScore`：reCAPTCHA v3 的最低分数，范围 0.1 到 0.9。

返回值包含 `method`、`provider`、`kind`、`taskId`、`cost`、`solveCount`、`applied`、`callbackInvoked`、`fieldsUpdated` 和稳定的 `errorCode`。完整令牌不会返回给 MCP 客户端，也不会写入日志。

自动检测与回填范围：

- reCAPTCHA v2、v3 和 Enterprise。
- hCaptcha；该类型通过 2Captcha v1 的 `method=hcaptcha` 提交。
- 独立 Cloudflare Turnstile。
- Cloudflare Managed Challenge，但必须同时配置浏览器代理和 `--2captcha-forward-proxy`。

2Captcha 目录中的图片、音频、坐标、Cookie 和多阶段任务并非统一令牌协议，因此不伪装成可自动回填。它们需要后续提供对应的页面参数提取与结果适配器。

## Native browser agent

An MCP client can normally complete workflows by composing the granular browser tools, so `run_task` is usually unnecessary. To use ChromiumFish's native browser agent, configure an OpenAI-compatible endpoint through these environment variables:

```text
OPENAI_API_KEY
OPENAI_API_BASE
OPENAI_API_MODEL
```

Then start the server with `--allow-native-agent`. This mode forwards the credentials to the local ChromiumFish browser process and enables unattended browser actions. Use it only in a trusted environment.
