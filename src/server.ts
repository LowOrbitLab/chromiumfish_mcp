import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserApi } from "./browser.js";
import type { ServerConfig } from "./config.js";
import { VERSION } from "./config.js";

const text = (value: unknown) => ({
  content: [{
    type: "text" as const,
    text: typeof value === "string" ? value : JSON.stringify(value),
  }],
});

const structured = <T extends object>(value: T) => ({
  ...text(value),
  structuredContent: value as Record<string, unknown>,
});

const READ_ONLY = {
  readOnlyHint: true,
} as const;

const MUTATING = {
  destructiveHint: false,
} as const;

const IDEMPOTENT_MUTATION = {
  ...MUTATING,
  idempotentHint: true,
} as const;

const DESTRUCTIVE = {
  destructiveHint: true,
} as const;

// Some MCP clients (or the model driving them) serialize nested object arguments
// to a JSON string. Accept either a native object or its JSON-string form so
// wait_for works across clients; a compliant object passes through unchanged.
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const waitConditionSchema = z.preprocess(parseMaybeJson, z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("element"),
    target: z.string().min(1),
    state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
    frameId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1),
    state: z.enum(["visible", "hidden"]).default("visible"),
    frameId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string().min(1),
  }),
  z.object({
    kind: z.literal("load"),
    state: z.enum(["load", "domcontentloaded", "networkidle"]),
  }),
  z.object({
    kind: z.literal("time"),
    timeMs: z.number().int().min(0).max(120_000),
  }),
]));

export function createServer(browser: BrowserApi, config: ServerConfig): McpServer {
  const server = new McpServer({ name: "chromiumfish_mcp", version: VERSION });

  server.registerTool(
    "list_pages",
    {
      description: "Report browser running state and list open pages without starting the browser.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => structured(await browser.listPages()),
  );

  server.registerTool(
    "open_page",
    {
      description: "Create and select a new page, optionally opening an HTTP/HTTPS URL.",
      inputSchema: { url: z.string().url().optional() },
      annotations: MUTATING,
    },
    async ({ url }) => structured(await browser.newPage(url)),
  );

  server.registerTool(
    "select_page",
    {
      description: "Select the current page by a pageId returned from list_pages.",
      inputSchema: { pageId: z.string().min(1) },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ pageId }) => structured(await browser.selectPage(pageId)),
  );

  server.registerTool(
    "close_page",
    {
      description: "Close the specified page, or the current page when pageId is omitted.",
      inputSchema: { pageId: z.string().min(1).optional() },
      annotations: DESTRUCTIVE,
    },
    async ({ pageId }) => structured(await browser.closePage(pageId)),
  );

  server.registerTool(
    "navigate",
    {
      description: "Open an HTTP/HTTPS URL in the current page and wait for DOMContentLoaded.",
      inputSchema: { url: z.string().url() },
      annotations: MUTATING,
    },
    async ({ url }) => structured(await browser.navigate(url)),
  );

  server.registerTool(
    "navigate_back",
    {
      description: "Navigate the current page to its previous history entry.",
      inputSchema: {},
      annotations: MUTATING,
    },
    async () => structured(await browser.goBack()),
  );

  server.registerTool(
    "navigate_forward",
    {
      description: "Navigate the current page to its next history entry.",
      inputSchema: {},
      annotations: MUTATING,
    },
    async () => structured(await browser.goForward()),
  );

  server.registerTool(
    "reload",
    {
      description: "Reload the current page and wait for DOMContentLoaded.",
      inputSchema: {},
      annotations: MUTATING,
    },
    async () => structured(await browser.reload()),
  );

  server.registerTool(
    "snapshot",
    {
      description: "List visible interactive elements in the main document or a frame, with bounded output and temporary references.",
      inputSchema: {
        frameId: z.string().min(1).optional(),
        scope: z.string().min(1).optional(),
        maxElements: z.number().int().min(1).max(250).default(100),
        maxChars: z.number().int().min(5_000).max(50_000).default(20_000),
      },
      annotations: READ_ONLY,
    },
    async ({ frameId, scope, maxElements, maxChars }) => text(await browser.snapshot({
      frameId,
      scope,
      maxElements,
      maxChars,
    })),
  );

  server.registerTool(
    "get_text",
    {
      description: "Read visible text from the first matching region in the main document or a frame, bounded by maxChars and --max-text-chars.",
      inputSchema: {
        frameId: z.string().min(1).optional(),
        selector: z.string().min(1).optional(),
        maxChars: z.number().int().min(100).max(100_000).default(20_000),
      },
      annotations: READ_ONLY,
    },
    async ({ frameId, selector, maxChars }) => text(await browser.getText({
      frameId,
      selector,
      maxChars,
    })),
  );

  server.registerTool(
    "take_screenshot",
    {
      description: "Capture the current viewport or the full page as a PNG image.",
      inputSchema: { fullPage: z.boolean().default(false) },
      annotations: READ_ONLY,
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
      description: "Click an element reference returned by snapshot or a CSS selector. Use frameId with selectors inside a frame.",
      inputSchema: {
        target: z.string().min(1),
        frameId: z.string().min(1).optional(),
      },
      annotations: MUTATING,
    },
    async ({ target, frameId }) => {
      await browser.click(target, frameId);
      return structured({ ok: true, target });
    },
  );

  server.registerTool(
    "hover",
    {
      description: "Move the mouse over an element reference or CSS selector without clicking.",
      inputSchema: {
        target: z.string().min(1),
        frameId: z.string().min(1).optional(),
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ target, frameId }) => {
      await browser.hover(target, frameId);
      return structured({ ok: true, target });
    },
  );

  server.registerTool(
    "click_at",
    {
      description:
        "Click page coordinates in CSS pixels from the viewport's top-left corner. Useful for controls inside cross-origin iframes that snapshot cannot enumerate.",
      inputSchema: {
        x: z.number().finite(),
        y: z.number().finite(),
      },
      annotations: MUTATING,
    },
    async ({ x, y }) => structured(await browser.mouseClick(x, y)),
  );

  server.registerTool(
    "list_frames",
    {
      description:
        "List frames and iframes with stable frameId values, parent relationships, URLs, and names. Request bounding boxes only when coordinate interaction needs them.",
      inputSchema: {
        includeBox: z.boolean().default(false),
      },
      annotations: READ_ONLY,
    },
    async ({ includeBox }) => structured({
      frames: await browser.listFrames({ includeBox }),
    }),
  );

  server.registerTool(
    "find_challenge",
    {
      description:
        "Detect common browser interstitials and embedded cross-origin challenge controls. Returns present, kind, widgetState, tokenPresent, the widget box, and related frames.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => structured(await browser.findChallenge()),
  );

  server.registerTool(
    "solve_challenge",
    {
      description:
        "Use human-like coordinate clicks on a standard checkbox inside a cross-origin challenge frame, then poll until clearance is confirmed by a response token, widget success state, or interstitial exit. Does not require a vision model; use the JSON ok field as the result.",
      inputSchema: {
        timeoutMs: z.number().int().min(3_000).max(180_000).default(45_000),
        maxClicks: z.number().int().min(1).max(30).default(6),
      },
      annotations: MUTATING,
    },
    async ({ timeoutMs, maxClicks }) => structured(
      await browser.clickChallenge({ timeoutMs, maxClicks }),
    ),
  );

  server.registerTool(
    "type_text",
    {
      description: "Focus an element and enter text, optionally clearing its current value and pressing Enter afterward. Use frameId with selectors inside a frame.",
      inputSchema: {
        target: z.string().min(1),
        text: z.string(),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
        frameId: z.string().min(1).optional(),
      },
      annotations: MUTATING,
    },
    async ({ target, text: value, clear, submit, frameId }) => {
      await browser.typeText(target, value, clear, submit, frameId);
      return structured({ ok: true, target, submitted: submit });
    },
  );

  server.registerTool(
    "select_option",
    {
      description: "Select one or more native dropdown options by value or label.",
      inputSchema: {
        target: z.string().min(1),
        values: z.array(z.string()).min(1).max(50),
        matchBy: z.enum(["value", "label"]).default("value"),
        frameId: z.string().min(1).optional(),
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ target, values, matchBy, frameId }) => structured({
      selectedValues: await browser.selectOption(target, values, matchBy, frameId),
    }),
  );

  server.registerTool(
    "set_checked",
    {
      description: "Set a checkbox state, or select a radio element with checked=true. Radios cannot be unchecked directly.",
      inputSchema: {
        target: z.string().min(1),
        checked: z.boolean(),
        frameId: z.string().min(1).optional(),
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ target, checked, frameId }) => structured({
      checked: await browser.setChecked(target, checked, frameId),
    }),
  );

  server.registerTool(
    "press_key",
    {
      description: "Press a key in the current page, such as Enter, Escape, ArrowDown, or Control+A.",
      inputSchema: { key: z.string().min(1).max(100) },
      annotations: MUTATING,
    },
    async ({ key }) => {
      await browser.pressKey(key);
      return structured({ ok: true, key });
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
      annotations: MUTATING,
    },
    async ({ deltaX, deltaY }) => {
      await browser.scroll(deltaX, deltaY);
      return structured({ ok: true, deltaX, deltaY });
    },
  );

  server.registerTool(
    "wait_for",
    {
      description: "Wait for one typed condition: element, text, URL glob, page load state, or duration.",
      inputSchema: {
        condition: waitConditionSchema,
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
      },
      annotations: READ_ONLY,
    },
    async ({ condition, timeoutMs }) => {
      await browser.waitFor({ condition, timeoutMs });
      return structured({ ok: true, kind: condition.kind });
    },
  );

  if (config.allowEval) {
    server.registerTool(
      "evaluate",
      {
        description: "Execute arbitrary JavaScript in the current page. This high-risk tool is registered only when --allow-eval is enabled.",
        inputSchema: { expression: z.string().min(1) },
        annotations: DESTRUCTIVE,
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
        annotations: DESTRUCTIVE,
      },
      async ({ task, url, maxSteps }) => structured(await browser.runTask(task, url, maxSteps)),
    );
  }

  return server;
}
