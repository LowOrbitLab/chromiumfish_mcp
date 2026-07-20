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
      description: "Returns whether the browser is running, the page count, and the current page. Never launches the browser just to report status.",
      inputSchema: {},
    },
    async () => text(await browser.status()),
  );

  server.registerTool(
    "list_pages",
    {
      description: "Lists all browser pages with their pageId, title, URL, and a current-page marker.",
      inputSchema: {},
    },
    async () => text(await browser.listPages()),
  );

  server.registerTool(
    "new_page",
    {
      description: "Creates and switches to a new page, optionally opening an HTTP/HTTPS URL.",
      inputSchema: { url: z.string().url().optional() },
    },
    async ({ url }) => text(await browser.newPage(url)),
  );

  server.registerTool(
    "select_page",
    {
      description: "Switches the current page by a pageId returned from list_pages.",
      inputSchema: { pageId: z.string().min(1) },
    },
    async ({ pageId }) => text(await browser.selectPage(pageId)),
  );

  server.registerTool(
    "close_page",
    {
      description: "Closes the given page; closes the current page when pageId is omitted.",
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
      description: "Opens an HTTP/HTTPS URL in the current page and waits for DOMContentLoaded.",
      inputSchema: { url: z.string().url() },
    },
    async ({ url }) => text(await browser.navigate(url)),
  );

  server.registerTool(
    "go_back",
    {
      description: "Moves the current page back one history entry.",
      inputSchema: {},
    },
    async () => text(await browser.goBack()),
  );

  server.registerTool(
    "snapshot",
    {
      description: "Lists the visible interactive elements of the current page. The returned refs (e1, e2, ...) can be passed to click, type_text, and wait_for; take a new snapshot after the page changes.",
      inputSchema: {},
    },
    async () => text(await browser.snapshot()),
  );

  server.registerTool(
    "get_text",
    {
      description: "Reads the visible text of the current page; output length is capped by --max-text-chars.",
      inputSchema: {},
    },
    async () => text(await browser.getText()),
  );

  server.registerTool(
    "screenshot",
    {
      description: "Captures a PNG of the current viewport or the full page.",
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
      description: "Clicks an element ref returned by snapshot, or a CSS selector.",
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
        "Clicks at page coordinates (CSS pixels, origin at the viewport's top-left). Use for controls inside cross-origin iframes that snapshot cannot enumerate.",
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
        "Lists the frames/iframes of the current page with their URL; includes the bounding box by default. includeBox=false returns only URL/name (faster).",
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
        "Detects a common browser interstitial or cross-origin challenge widget on the current page. Returns present, kind, widgetState, tokenPresent, the widget box, and related frames.",
      inputSchema: {},
    },
    async () => text(await browser.detectChallenge()),
  );

  server.registerTool(
    "click_challenge",
    {
      description:
        "Performs a human-like coordinate click on the standard checkbox widget inside a cross-origin challenge frame, then polls until clearance is confirmed (response token / widget success state / interstitial left). Needs no vision model. The JSON ok field is authoritative.",
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
      description: "Focuses an element and types text, optionally clearing the existing value first and pressing Enter afterwards.",
      inputSchema: {
        target: z.string().min(1),
        text: z.string(),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
      },
    },
    async ({ target, text: value, clear, submit }) => {
      await browser.typeText(target, value, clear, submit);
      return text(`Typed text into ${target}${submit ? " and pressed Enter" : ""}`);
    },
  );

  server.registerTool(
    "press_key",
    {
      description: "Presses a key in the current page, for example Enter, Escape, ArrowDown, or Control+A.",
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
      description: "Scrolls the current page; positive deltaY scrolls down, negative scrolls up.",
      inputSchema: {
        deltaX: z.number().finite().default(0),
        deltaY: z.number().finite(),
      },
    },
    async ({ deltaX, deltaY }) => {
      await browser.scroll(deltaX, deltaY);
      return text("Scrolled");
    },
  );

  server.registerTool(
    "wait_for",
    {
      description: "Waits for an element ref or CSS selector to reach the given state.",
      inputSchema: {
        target: z.string().min(1),
        state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      },
    },
    async ({ target, state, timeoutMs }) => {
      await browser.waitFor(target, state, timeoutMs);
      return text(`${target} reached state ${state}`);
    },
  );

  if (config.allowEval) {
    server.registerTool(
      "eval_js",
      {
        description: "Runs arbitrary JavaScript in the current page. This high-risk tool is registered only with --allow-eval.",
        inputSchema: { expression: z.string().min(1) },
      },
      async ({ expression }) => text(await browser.evalJs(expression)),
    );
  }

  if (config.allowNativeAgent) {
    server.registerTool(
      "run_task",
      {
        description: "Hands a complete goal to the ChromiumFish built-in browser agent. Requires an OpenAI-compatible endpoint configured through environment variables.",
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
