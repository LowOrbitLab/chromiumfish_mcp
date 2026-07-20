# chromiumfish_mcp

`chromiumfish_mcp` 是面向 [ChromiumFish](https://github.com/arman-bd/chromiumfish) 的独立 Model Context Protocol（MCP）服务器。它让 Claude Code、Claude Desktop、Cursor 以及其他 MCP 客户端能够通过结构化工具控制 ChromiumFish 浏览器。

本项目复用 ChromiumFish 官方 npm 包，不包含 Chromium 源码或浏览器二进制。浏览器会在首次调用浏览器工具时由上游 SDK 下载并按版本缓存。

## 特性

- MCP stdio 传输，适合本地桌面和开发工具。
- 浏览器按需启动，MCP 客户端断开时自动清理。
- 多页面管理：新建、切换、列出和关闭页面。
- 快照元素引用：使用 `e1`、`e2` 操作当前快照中的元素。
- 导航、正文、截图、点击、输入、按键、滚动和等待工具。
- 支持 ChromiumFish 人格种子、代理、窗口尺寸和时区。
- `eval_js` 与浏览器内置代理默认不注册，必须显式启用。
- 可配置导航主机白名单与文本输出上限。

## 环境要求

- Node.js 20 或更高版本。
- ChromiumFish 当前支持的操作系统与硬件架构。
- 首次启动需要联网下载 ChromiumFish 浏览器构建。

自动下载取决于 ChromiumFish 上游 Release 是否提供当前平台的构建资产。如果没有对应资产，可以自行构建 ChromiumFish，并通过 `--chrome-path` 或 `CHROME_BIN` 指向可执行文件。

## 安装

从 GitHub 安装：

```bash
npm install --global github:LowOrbitLab/chromiumfish_mcp
```

安装后可以运行：

```bash
chromiumfish_mcp --persona-seed alice
```

也可以不全局安装：

```bash
npx --yes github:LowOrbitLab/chromiumfish_mcp --persona-seed alice
```

## MCP 客户端配置

使用全局安装的命令：

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

直接从 GitHub 运行：

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

Windows 客户端如果无法解析 `npx`，可以将 `command` 改为 `npx.cmd`。

## 工具

- `browser_status`：查询懒启动状态。
- `list_pages`、`new_page`、`select_page`、`close_page`：管理页面。
- `navigate`、`go_back`：导航与历史记录。
- `snapshot`：读取可交互元素并生成临时引用。
- `get_text`、`screenshot`：获取页面内容。
- `click`、`type_text`、`press_key`、`scroll`、`wait_for`：执行页面操作。
- `eval_js`：任意 JavaScript，仅在 `--allow-eval` 下提供。
- `run_task`：ChromiumFish 浏览器内置代理，仅在 `--allow-native-agent` 下提供。

调用 `snapshot` 后会得到如下结果：

```text
[e1] input "搜索"
[e2] button "提交"
[e3] link "文档" -> https://example.com/docs
```

将 `e1` 传给 `type_text`，或将 `e2` 传给 `click`。元素引用只属于当前页面的最近一次快照；页面变化后应重新调用 `snapshot`。

## 启动选项

```text
--persona-seed VALUE       固定浏览器指纹人格
--chrome-path PATH         使用本地 ChromiumFish 可执行文件
--browser-version VERSION  指定上游浏览器构建版本
--headed                  显示浏览器窗口
--window-size WIDTHxHEIGHT 窗口尺寸
--timezone ZONE           IANA 时区或 auto
--proxy URL               浏览器代理
--allowed-host HOST       导航主机白名单，可重复传入
--max-text-chars N        页面正文最大字符数
--allow-eval              启用任意 JavaScript
--allow-native-agent      启用浏览器内置代理
```

代理凭据可以写在代理 URL 中，但这会使凭据出现在 MCP 客户端配置里。不要提交包含代理密码、Cookie 或 API Key 的配置文件。

## 浏览器内置代理

MCP 客户端本身已经可以组合细粒度浏览器工具，因此通常不需要 `run_task`。确实需要 ChromiumFish 的浏览器内置代理时，通过环境变量提供 OpenAI 兼容接口：

```text
OPENAI_API_KEY
OPENAI_API_BASE
OPENAI_API_MODEL
```

然后加入 `--allow-native-agent`。该模式会把密钥转交给本地 ChromiumFish 浏览器进程，并启用无人值守操作能力，只应在受信任环境使用。

## 安全边界

- 服务仅提供 stdio，不应直接暴露 Chromium DevTools 端口到公网。
- `eval_js` 默认关闭，因为它可以读取或修改页面中的任何数据。
- 使用 `--allowed-host example.com` 可以限制导航范围，子域名也会被允许。
- MCP 客户端能够点击和输入，可能产生外部副作用；涉及购买、发布或删除数据时应保留人工确认。
- 每个 MCP 进程维护独立浏览器上下文，不面向多租户共享。

## 本地开发

```bash
npm ci
npm test
node dist/index.js --help
```

单元测试通过内存 MCP 传输验证工具发现、危险工具开关和调用结果，不会下载或启动浏览器。

## 许可证与归属

本项目使用 MIT 许可证。ChromiumFish 相关代码和名称归其原项目贡献者所有；详情见 [NOTICE](NOTICE)。本项目是独立封装，不代表 ChromiumFish 官方发布。
