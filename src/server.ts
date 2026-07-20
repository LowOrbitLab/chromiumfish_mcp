import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserApi } from "./browser.js";
import type { ServerConfig } from "./config.js";
import { VERSION } from "./config.js";

const text = (value: unknown) => ({
  content: [{
    type: "text" as const,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  }],
});

export function createServer(browser: BrowserApi, config: ServerConfig): McpServer {
  const server = new McpServer({ name: "chromiumfish_mcp", version: VERSION });

  server.registerTool(
    "browser_status",
    {
      description: "返回浏览器是否启动、页面数量和当前页面。不会为了查询状态而启动浏览器。",
      inputSchema: {},
    },
    async () => text(await browser.status()),
  );

  server.registerTool(
    "list_pages",
    {
      description: "列出所有浏览器页面及其 pageId、标题、URL 和当前页面标记。",
      inputSchema: {},
    },
    async () => text(await browser.listPages()),
  );

  server.registerTool(
    "new_page",
    {
      description: "新建并切换到一个页面，可选地打开 HTTP/HTTPS URL。",
      inputSchema: { url: z.string().url().optional() },
    },
    async ({ url }) => text(await browser.newPage(url)),
  );

  server.registerTool(
    "select_page",
    {
      description: "通过 list_pages 返回的 pageId 切换当前页面。",
      inputSchema: { pageId: z.string().min(1) },
    },
    async ({ pageId }) => text(await browser.selectPage(pageId)),
  );

  server.registerTool(
    "close_page",
    {
      description: "关闭指定页面；省略 pageId 时关闭当前页面。",
      inputSchema: { pageId: z.string().min(1).optional() },
    },
    async ({ pageId }) => {
      await browser.closePage(pageId);
      return text("页面已关闭");
    },
  );

  server.registerTool(
    "navigate",
    {
      description: "在当前页面打开 HTTP/HTTPS URL，并等待 DOMContentLoaded。",
      inputSchema: { url: z.string().url() },
    },
    async ({ url }) => text(await browser.navigate(url)),
  );

  server.registerTool(
    "go_back",
    {
      description: "让当前页面返回上一条历史记录。",
      inputSchema: {},
    },
    async () => text(await browser.goBack()),
  );

  server.registerTool(
    "snapshot",
    {
      description: "列出当前页面可见的交互元素。返回的 e1、e2 等引用可传给 click、type_text 和 wait_for；页面变化后应重新获取快照。",
      inputSchema: {},
    },
    async () => text(await browser.snapshot()),
  );

  server.registerTool(
    "get_text",
    {
      description: "读取当前页面可见正文，输出长度受 --max-text-chars 限制。",
      inputSchema: {},
    },
    async () => text(await browser.getText()),
  );

  server.registerTool(
    "screenshot",
    {
      description: "截取当前视口或整个页面的 PNG 图片。",
      inputSchema: { fullPage: z.boolean().default(false) },
    },
    async ({ fullPage }) => ({
      content: [{
        type: "image" as const,
        data: (await browser.screenshot(fullPage)).toString("base64"),
        mimeType: "image/png",
      }],
    }),
  );

  server.registerTool(
    "click",
    {
      description: "点击 snapshot 返回的元素引用，也可传入 CSS selector。",
      inputSchema: { target: z.string().min(1) },
    },
    async ({ target }) => {
      await browser.click(target);
      return text(`已点击 ${target}`);
    },
  );

  server.registerTool(
    "mouse_click",
    {
      description:
        "按页面坐标点击（CSS 像素，原点在视口左上角）。适用于 snapshot 无法枚举的跨域 iframe 内控件。",
      inputSchema: {
        x: z.number().finite(),
        y: z.number().finite(),
      },
    },
    async ({ x, y }) => text(await browser.mouseClick(x, y)),
  );

  server.registerTool(
    "list_frames",
    {
      description:
        "列出当前页面的 frame/iframe，包含 URL；默认附带 bounding box。includeBox=false 可只返回 URL/name（更快）。",
      inputSchema: {
        includeBox: z.boolean().default(true),
      },
    },
    async ({ includeBox }) => text(await browser.listFrames({ includeBox })),
  );

  server.registerTool(
    "detect_challenge",
    {
      description:
        "检测当前页是否出现常见的浏览器 interstitial / 跨域 challenge 嵌入控件。返回 present、kind、widgetState、tokenPresent、widget 坐标框与相关 frame。",
      inputSchema: {},
    },
    async () => text(await browser.detectChallenge()),
  );

  const clickChallengeInput = {
    timeoutMs: z.number().int().min(3_000).max(180_000).default(45_000),
    maxClicks: z.number().int().min(1).max(30).default(6),
  };
  const clickChallengeHandler = async ({
    timeoutMs,
    maxClicks,
  }: {
    timeoutMs: number;
    maxClicks: number;
  }) => text(await browser.solveTurnstile({ timeoutMs, maxClicks }));

  server.registerTool(
    "click_challenge",
    {
      description:
        "对跨域 challenge frame 内的标准 checkbox 控件做拟人坐标点击，并轮询直到确认清除（response token / widget 成功态 / 离开 interstitial）。不依赖视觉模型。结果以 JSON 的 ok 字段为准。",
      inputSchema: clickChallengeInput,
    },
    clickChallengeHandler,
  );

  // Backward-compatible alias (same handler). Prefer click_challenge in new integrations.
  server.registerTool(
    "solve_turnstile",
    {
      description:
        "click_challenge 的别名（兼容旧名）。对跨域 challenge checkbox 做坐标点击并确认清除。新接入请优先用 click_challenge。",
      inputSchema: clickChallengeInput,
    },
    clickChallengeHandler,
  );

  server.registerTool(
    "type_text",
    {
      description: "聚焦元素后输入文本，可先清空原值并在输入后按 Enter。",
      inputSchema: {
        target: z.string().min(1),
        text: z.string(),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
      },
    },
    async ({ target, text: value, clear, submit }) => {
      await browser.typeText(target, value, clear, submit);
      return text(`已向 ${target} 输入文本${submit ? "并按下 Enter" : ""}`);
    },
  );

  server.registerTool(
    "press_key",
    {
      description: "在当前页面按键，例如 Enter、Escape、ArrowDown 或 Control+A。",
      inputSchema: { key: z.string().min(1).max(100) },
    },
    async ({ key }) => {
      await browser.pressKey(key);
      return text(`已按下 ${key}`);
    },
  );

  server.registerTool(
    "scroll",
    {
      description: "滚动当前页面；正 deltaY 向下，负 deltaY 向上。",
      inputSchema: {
        deltaX: z.number().finite().default(0),
        deltaY: z.number().finite(),
      },
    },
    async ({ deltaX, deltaY }) => {
      await browser.scroll(deltaX, deltaY);
      return text("滚动完成");
    },
  );

  server.registerTool(
    "wait_for",
    {
      description: "等待元素引用或 CSS selector 达到指定状态。",
      inputSchema: {
        target: z.string().min(1),
        state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      },
    },
    async ({ target, state, timeoutMs }) => {
      await browser.waitFor(target, state, timeoutMs);
      return text(`${target} 已达到 ${state} 状态`);
    },
  );

  if (config.allowEval) {
    server.registerTool(
      "eval_js",
      {
        description: "在当前页面执行任意 JavaScript。该高风险工具只有使用 --allow-eval 时才会注册。",
        inputSchema: { expression: z.string().min(1) },
      },
      async ({ expression }) => text(await browser.evalJs(expression)),
    );
  }

  if (config.allowNativeAgent) {
    server.registerTool(
      "run_task",
      {
        description: "把完整目标交给 ChromiumFish 浏览器内置代理。需要通过环境变量配置 OpenAI 兼容接口。",
        inputSchema: {
          task: z.string().min(1),
          url: z.string().url().optional(),
          maxSteps: z.number().int().min(1).max(100).default(25),
        },
      },
      async ({ task, url, maxSteps }) => text(await browser.runTask(task, url, maxSteps)),
    );
  }

  return server;
}
