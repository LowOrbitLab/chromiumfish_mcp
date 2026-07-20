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
      description: "Report whether the browser is running, the page count, and the current page. Does not start the browser just to inspect status.",
      inputSchema: {},
    },
    async () => text(await browser.status()),
  );

  server.registerTool(
    "list_pages",
    {
      description: "List all browser pages with their pageId, title, URL, and current-page marker.",
      inputSchema: {},
    },
    async () => text(await browser.listPages()),
  );

  server.registerTool(
    "new_page",
    {
      description: "Create and select a new page, optionally opening an HTTP/HTTPS URL.",
      inputSchema: { url: z.string().url().optional() },
    },
    async ({ url }) => text(await browser.newPage(url)),
  );

  server.registerTool(
    "select_page",
    {
      description: "Select the current page by a pageId returned from list_pages.",
      inputSchema: { pageId: z.string().min(1) },
    },
    async ({ pageId }) => text(await browser.selectPage(pageId)),
  );

  server.registerTool(
    "close_page",
    {
      description: "Close the specified page, or the current page when pageId is omitted.",
      inputSchema: { pageId: z.string().min(1).optional() },
    },
    async ({ pageId }) => {
      await browser.closePage(pageId);
      return text("Page closed");
    },
  );

  server.registerTool(
    "navigate",
    {
      description: "Open an HTTP/HTTPS URL in the current page and wait for DOMContentLoaded.",
      inputSchema: { url: z.string().url() },
    },
    async ({ url }) => text(await browser.navigate(url)),
  );

  server.registerTool(
    "go_back",
    {
      description: "Navigate the current page to its previous history entry.",
      inputSchema: {},
    },
    async () => text(await browser.goBack()),
  );

  server.registerTool(
    "snapshot",
    {
      description: "List visible interactive elements. Pass references such as e1 and e2 to click, type_text, or wait_for; take a new snapshot after the page changes.",
      inputSchema: {},
    },
    async () => text(await browser.snapshot()),
  );

  server.registerTool(
    "get_text",
    {
      description: "Read visible text from the current page, limited by --max-text-chars.",
      inputSchema: {},
    },
    async () => text(await browser.getText()),
  );

  server.registerTool(
    "screenshot",
    {
      description: "Capture the current viewport or the full page as a PNG image.",
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
      description: "Click an element reference returned by snapshot or a CSS selector.",
      inputSchema: { target: z.string().min(1) },
    },
    async ({ target }) => {
      await browser.click(target);
      return text(`Clicked ${target}`);
    },
  );

  server.registerTool(
    "mouse_click",
    {
      description:
        "Click page coordinates in CSS pixels from the viewport's top-left corner. Useful for controls inside cross-origin iframes that snapshot cannot enumerate.",
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
        "List frames and iframes in the current page with their URLs. Bounding boxes are included by default; set includeBox=false for faster URL/name-only results.",
      inputSchema: {
        includeBox: z.boolean().default(true),
      },
    },
    async ({ includeBox }) => text(await browser.listFrames({ includeBox })),
  );

  server.registerTool(
    "find_challenge",
    {
      description:
        "Detect common browser interstitials and embedded cross-origin challenge controls. Returns present, kind, widgetState, tokenPresent, the widget box, and related frames.",
      inputSchema: {},
    },
    async () => text(await browser.findChallenge()),
  );

  server.registerTool(
    "click_challenge",
    {
      description:
        "Use human-like coordinate clicks on a standard checkbox inside a cross-origin challenge frame, then poll until clearance is confirmed by a response token, widget success state, or interstitial exit. Does not require a vision model; use the JSON ok field as the result.",
      inputSchema: {
        timeoutMs: z.number().int().min(3_000).max(180_000).default(45_000),
        maxClicks: z.number().int().min(1).max(30).default(6),
      },
    },
    async ({ timeoutMs, maxClicks }) => text(await browser.clickChallenge({ timeoutMs, maxClicks })),
  );

  server.registerTool(
    "type_text",
    {
      description: "Focus an element and enter text, optionally clearing its current value and pressing Enter afterward.",
      inputSchema: {
        target: z.string().min(1),
        text: z.string(),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
      },
    },
    async ({ target, text: value, clear, submit }) => {
      await browser.typeText(target, value, clear, submit);
      return text(`Entered text in ${target}${submit ? " and pressed Enter" : ""}`);
    },
  );

  server.registerTool(
    "press_key",
    {
      description: "Press a key in the current page, such as Enter, Escape, ArrowDown, or Control+A.",
      inputSchema: { key: z.string().min(1).max(100) },
    },
    async ({ key }) => {
      await browser.pressKey(key);
      return text(`Pressed ${key}`);
    },
  );

  server.registerTool(
    "scroll",
    {
      description: "Scroll the current page; positive deltaY scrolls down and negative deltaY scrolls up.",
      inputSchema: {
        deltaX: z.number().finite().default(0),
        deltaY: z.number().finite(),
      },
    },
    async ({ deltaX, deltaY }) => {
      await browser.scroll(deltaX, deltaY);
      return text("Scroll complete");
    },
  );

  server.registerTool(
    "wait_for",
    {
      description: "Wait for an element reference or CSS selector to reach the requested state.",
      inputSchema: {
        target: z.string().min(1),
        state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      },
    },
    async ({ target, state, timeoutMs }) => {
      await browser.waitFor(target, state, timeoutMs);
      return text(`${target} reached the ${state} state`);
    },
  );

  if (config.allowEval) {
    server.registerTool(
      "eval_js",
      {
        description: "Execute arbitrary JavaScript in the current page. This high-risk tool is registered only when --allow-eval is enabled.",
        inputSchema: { expression: z.string().min(1) },
      },
      async ({ expression }) => text(await browser.evalJs(expression)),
    );
  }

  if (config.allowNativeAgent) {
    server.registerTool(
      "run_task",
      {
        description: "Delegate a complete goal to the native ChromiumFish browser agent. Requires an OpenAI-compatible endpoint configured through environment variables.",
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
