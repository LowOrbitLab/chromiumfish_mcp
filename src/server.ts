import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserApi } from "./browser.js";
import type { ServerConfig } from "./config.js";
import { SNAPSHOT_CHARS, SNAPSHOT_ELEMENTS, TEXT_CHARS, VERSION } from "./config.js";
// turnstile.ts is a pure module with no Playwright imports, so depending on it here keeps
// the browser-free testability this file relies on.
import { SOLVE_MAX_CLICKS, SOLVE_TIMEOUT_MS } from "./turnstile.js";
import { withOperationSignal } from "./operation-queue.js";

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

/**
 * Action results may carry a snapshot. Emit it as its own plain-text block so the model
 * reads real newlines instead of a JSON-escaped blob, and keep it out of
 * structuredContent so clients that forward both fields do not pay for it twice.
 */
const action = <T extends { snapshot?: string }>(value: T) => {
  const { snapshot, ...state } = value;
  const stateBlock = { type: "text" as const, text: JSON.stringify(state) };
  return {
    content: snapshot === undefined
      ? [stateBlock]
      : [stateBlock, { type: "text" as const, text: snapshot }],
    structuredContent: state as Record<string, unknown>,
  };
};

/** Opt-in follow-up snapshot, shared by every tool that changes page state. */
const returnSnapshotInput = {
  returnSnapshot: z.boolean().default(false)
    .describe("Also return a fresh snapshot of the resulting page; renumbers element refs."),
};

const INSTRUCTIONS = `Drives one persistent ChromiumFish browser context over MCP.

Page actions in one browser session run serially in arrival order; page selection and
snapshots queue too.

Workflow: navigate -> snapshot -> act on refs (e1, e2, ...) -> act again.

Element references
- Refs belong to the latest snapshot of one page and frame. Any navigation, the next
  snapshot, and closing the page invalidate them.
- Numbers are identifiers, not positions, and are never reused: snapshots keep counting
  up (e1..e40, then e41..e77). A ref from an earlier snapshot therefore fails with an
  error rather than acting on whatever element now sits in that slot. Re-snapshot instead
  of guessing, and do not infer order or position from the number.

Targeting
- Every target field also accepts a selector. Prefer role=<role>[name="<label>"], built
  from the role and label the snapshot already printed - it survives the re-renders that
  invalidate refs, and costs nothing extra to read. Name matching is case-insensitive and
  matches a substring.
- Snapshot roles are ARIA roles wherever HTML defines one (link, button, textbox,
  checkbox, radio, combobox, listbox, searchbox, slider, spinbutton). Anything else is a
  tag name - for example a password field prints "input" - and cannot be used with role=;
  target those by ref or CSS selector.
- Targeting fails within a few seconds when nothing matches, so a wrong selector is
  cheap to discover. For an element that has not rendered yet, use wait_for first
  rather than retrying the action.

Action results
- navigate, click, hover, type_text, select_option, set_checked, press_key, scroll,
  wait_for, click_at, and drag return the resulting url and title plus navigated and newPages.
  Read those instead of calling snapshot reflexively: re-snapshot only when navigated is
  true or the part of the DOM you need has changed.
- navigate, navigate_back, navigate_forward, and reload always report navigated: true.
  They invalidate refs even when the URL is unchanged, so always re-snapshot after one.
- Those four also report the HTTP status. A 404 or a 500 loads like any other page and many
  sites answer both with something that reads like content, so check status before treating
  the body as the page you asked for.
- navigationPending: true means the action started a navigation that had not landed yet, so
  url and title still describe the page being left. The action itself worked - wait_for the
  destination rather than repeating it, which on a login or a purchase would submit twice.
- navigationFailed means the opposite: the navigation the action started is never arriving,
  because it was blocked, the host did not resolve, or the browser handed the URL to
  another application. The page did not move and waiting for it would wait forever. It
  carries the URL and the browser's own reason; net::ERR_BLOCKED_BY_CLIENT is --allowed-host.
- Pass returnSnapshot: true to get the action result and a fresh snapshot in one call.
- snapshotError means the action completed but the follow-up snapshot failed. Keep the
  action result and retry only the read; do not repeat a click, submit, or upload over it.
- newPages lists tabs the action opened. The current page never switches automatically;
  use select_page to move to one.

Dialogs and downloads
- A JavaScript dialog is answered the instant it opens: a page left waiting on one freezes,
  and no later tool call would finish. Unarmed, the answer is dismiss - so a click that
  raised confirm("Delete?") did NOT delete. Action results list what opened in dialogs;
  read it before concluding an action took effect.
- To accept one, call handle_dialog and then repeat the action. It arms the next dialog;
  it cannot change an answer already given.
- Downloads appear in downloads on the action result. They are kept only when the server
  was started with --download-dir, and report state: "discarded" otherwise. A large file is
  still "pending" when the action returns - call list_downloads to see it settle.

Challenges
- On Cloudflare or "Just a moment" pages call find_challenge, then solve_challenge.
- Never read challenge-frame DOM or probe cf-turnstile-response inputs; it measurably
  lowers clearance rates and DOM access to those frames is blocked.
- solve_challenge ok: false is terminal. Change network path or strategy rather than
  retrying in a loop.
- ok: true only means the page is not blocked. Never describe a challenge as solved or
  bypassed unless clearanceVerified is true, and never describe one as encountered unless
  challengeObserved is true - on an unchallenged page ok is true with both false.

Cost
- Prefer snapshot and get_text over take_screenshot; use screenshots only for questions
  that genuinely need pixels. When one is needed, take_screenshot with target crops to a
  single element and costs a fraction of a viewport image.`;

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
  const server = new McpServer(
    { name: "chromiumfish_mcp", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  const registerTool = <Args extends z.ZodRawShape>(
    name: string,
    definition: { description: string; inputSchema: Args; annotations: Record<string, boolean> },
    callback: ToolCallback<Args>,
  ) => server.registerTool(name, definition, ((args, extra) =>
    withOperationSignal(extra.signal, () => callback(args, extra))) as ToolCallback<Args>);

  registerTool(
    "list_pages",
    {
      description: "Report browser running state and list open pages without starting the browser.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => structured(await browser.listPages()),
  );

  registerTool(
    "open_page",
    {
      description: "Create and select a new page, optionally opening an HTTP/HTTPS URL.",
      inputSchema: { url: z.url().optional() },
      annotations: MUTATING,
    },
    async ({ url }) => structured(await browser.openPage(url)),
  );

  registerTool(
    "select_page",
    {
      description: "Select the current page by a pageId returned from list_pages.",
      inputSchema: { pageId: z.string().min(1) },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ pageId }) => structured(await browser.selectPage(pageId)),
  );

  registerTool(
    "close_page",
    {
      description: "Close the specified page, or the current page when pageId is omitted.",
      inputSchema: { pageId: z.string().min(1).optional() },
      annotations: DESTRUCTIVE,
    },
    async ({ pageId }) => structured(await browser.closePage(pageId)),
  );

  registerTool(
    "navigate",
    {
      description: "Open an HTTP/HTTPS URL in the current page and wait for DOMContentLoaded.",
      inputSchema: { url: z.url(), ...returnSnapshotInput },
      annotations: MUTATING,
    },
    async ({ url, returnSnapshot }) => action(await browser.navigate(url, { returnSnapshot })),
  );

  registerTool(
    "navigate_back",
    {
      description: "Navigate the current page to its previous history entry.",
      inputSchema: { ...returnSnapshotInput },
      annotations: MUTATING,
    },
    async ({ returnSnapshot }) => action(await browser.navigateBack({ returnSnapshot })),
  );

  registerTool(
    "navigate_forward",
    {
      description: "Navigate the current page to its next history entry.",
      inputSchema: { ...returnSnapshotInput },
      annotations: MUTATING,
    },
    async ({ returnSnapshot }) => action(await browser.navigateForward({ returnSnapshot })),
  );

  registerTool(
    "reload",
    {
      description: "Reload the current page and wait for DOMContentLoaded.",
      inputSchema: { ...returnSnapshotInput },
      annotations: MUTATING,
    },
    async ({ returnSnapshot }) => action(await browser.reload({ returnSnapshot })),
  );

  registerTool(
    "snapshot",
    {
      description: "List visible interactive elements in the main document or a frame, with bounded output and temporary references.",
      inputSchema: {
        frameId: z.string().min(1).optional(),
        scope: z.string().min(1).optional(),
        maxElements: z.number().int()
          .min(SNAPSHOT_ELEMENTS.min).max(SNAPSHOT_ELEMENTS.max).default(SNAPSHOT_ELEMENTS.default),
        maxChars: z.number().int()
          .min(SNAPSHOT_CHARS.min).max(SNAPSHOT_CHARS.max).default(SNAPSHOT_CHARS.default),
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

  registerTool(
    "get_text",
    {
      description: "Read visible text from the first matching region in the main document or a frame, bounded by maxChars and --max-text-chars.",
      inputSchema: {
        frameId: z.string().min(1).optional(),
        selector: z.string().min(1).optional(),
        maxChars: z.number().int()
          .min(TEXT_CHARS.min).max(TEXT_CHARS.max).default(TEXT_CHARS.default),
      },
      annotations: READ_ONLY,
    },
    async ({ frameId, selector, maxChars }) => text(await browser.getText({
      frameId,
      selector,
      maxChars,
    })),
  );

  registerTool(
    "take_screenshot",
    {
      description:
        "Capture the viewport, the full page, or a single element as a PNG image. Pass target "
        + "to crop to one element, which costs far fewer tokens than a full viewport image.",
      inputSchema: {
        fullPage: z.boolean().default(false),
        target: z.string().min(1).optional(),
        frameId: z.string().min(1).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ fullPage, target, frameId }) => ({
      content: [{
        type: "image" as const,
        data: (await browser.takeScreenshot({ fullPage, target, frameId })).toString("base64"),
        mimeType: "image/png",
      }],
    }),
  );

  registerTool(
    "click",
    {
      description: "Click an element reference returned by snapshot or a CSS selector. Use frameId with selectors inside a frame. Returns the resulting url, title, navigated, and any newPages.",
      inputSchema: {
        target: z.string().min(1),
        frameId: z.string().min(1).optional(),
        ...returnSnapshotInput,
      },
      annotations: MUTATING,
    },
    async ({ target, frameId, returnSnapshot }) => action({
      ...await browser.click(target, frameId, { returnSnapshot }),
      target,
    }),
  );

  registerTool(
    "hover",
    {
      description: "Move the mouse over an element reference or CSS selector without clicking.",
      inputSchema: {
        target: z.string().min(1),
        frameId: z.string().min(1).optional(),
        ...returnSnapshotInput,
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ target, frameId, returnSnapshot }) => action({
      ...await browser.hover(target, frameId, { returnSnapshot }),
      target,
    }),
  );

  registerTool(
    "click_at",
    {
      description:
        "Click page coordinates in CSS pixels from the viewport's top-left corner. Useful for controls inside cross-origin iframes that snapshot cannot enumerate.",
      inputSchema: {
        x: z.number().finite(),
        y: z.number().finite(),
        ...returnSnapshotInput,
      },
      annotations: MUTATING,
    },
    async ({ x, y, returnSnapshot }) => action(await browser.clickAt(x, y, { returnSnapshot })),
  );

  registerTool(
    "drag",
    {
      description:
        "Press on an element, move with a human-like curved path, and release. Give exactly one "
        + "destination: toTarget to drop onto another element, or dx/dy to drag by a pixel offset "
        + "(what slider controls need). Both ends must be on screen at once. Returns the from and "
        + "to points actually used.",
      inputSchema: {
        target: z.string().min(1),
        toTarget: z.string().min(1).optional(),
        dx: z.number().finite().optional(),
        dy: z.number().finite().optional(),
        frameId: z.string().min(1).optional(),
        ...returnSnapshotInput,
      },
      annotations: MUTATING,
    },
    async ({ target, toTarget, dx, dy, frameId, returnSnapshot }) => action({
      ...await browser.drag(target, { toTarget, dx, dy }, frameId, { returnSnapshot }),
      target,
    }),
  );

  registerTool(
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

  registerTool(
    "handle_dialog",
    {
      description:
        "Arm the answer for the next JavaScript dialog (alert, confirm, prompt, beforeunload) "
        + "on the current page. Dialogs are answered the instant they open, because a page "
        + "waiting on one freezes and no later call could finish — so this is set before the "
        + "action that raises one, not after. Left unarmed, a dialog is dismissed, and the "
        + "action result reports it under dialogs so a click that only raised a confirm is not "
        + "mistaken for one that went through.",
      inputSchema: {
        accept: z.boolean(),
        promptText: z.string().max(1_000).optional()
          .describe("Text to enter when accepting a prompt; ignored for other dialog types."),
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ accept, promptText }) => structured(await browser.handleDialog(accept, promptText)),
  );

  registerTool(
    "find_challenge",
    {
      description:
        "Detect common browser interstitials and embedded cross-origin challenge controls. Returns present, kind, widgetState, tokenPresent, the widget box, and related frames.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => structured(await browser.findChallenge()),
  );

  registerTool(
    "solve_challenge",
    {
      description:
        "Use human-like coordinate clicks on a standard checkbox inside a cross-origin challenge "
        + "frame, then poll until clearance is confirmed by a response token, widget success state, "
        + "or interstitial exit. Does not require a vision model. ok means the page is not blocked "
        + "and you may continue - it does not mean a challenge was defeated. Report what happened "
        + "from challengeObserved, interactionPerformed, and clearanceVerified: on a page that was "
        + "never challenged all three are false while ok is true.",
      inputSchema: {
        timeoutMs: z.number().int()
          .min(SOLVE_TIMEOUT_MS.min).max(SOLVE_TIMEOUT_MS.max).default(SOLVE_TIMEOUT_MS.default),
        maxClicks: z.number().int()
          .min(SOLVE_MAX_CLICKS.min).max(SOLVE_MAX_CLICKS.max).default(SOLVE_MAX_CLICKS.default),
      },
      annotations: MUTATING,
    },
    async ({ timeoutMs, maxClicks }) => structured(
      await browser.solveChallenge({ timeoutMs, maxClicks }),
    ),
  );

  registerTool(
    "type_text",
    {
      description: "Focus an element and enter text, optionally clearing its current value and pressing Enter afterward. Use frameId with selectors inside a frame.",
      inputSchema: {
        target: z.string().min(1),
        text: z.string(),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false),
        frameId: z.string().min(1).optional(),
        ...returnSnapshotInput,
      },
      annotations: MUTATING,
    },
    async ({ target, text: value, clear, submit, frameId, returnSnapshot }) => action({
      ...await browser.typeText(target, value, clear, submit, frameId, { returnSnapshot }),
      target,
      submitted: submit,
    }),
  );

  registerTool(
    "select_option",
    {
      description: "Select one or more native dropdown options by value or label.",
      inputSchema: {
        target: z.string().min(1),
        values: z.array(z.string()).min(1).max(50),
        matchBy: z.enum(["value", "label"]).default("value"),
        frameId: z.string().min(1).optional(),
        ...returnSnapshotInput,
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ target, values, matchBy, frameId, returnSnapshot }) => action({
      ...await browser.selectOption(target, values, matchBy, frameId, { returnSnapshot }),
      target,
    }),
  );

  registerTool(
    "set_checked",
    {
      description: "Set a checkbox state, or select a radio element with checked=true. Radios cannot be unchecked directly.",
      inputSchema: {
        target: z.string().min(1),
        checked: z.boolean(),
        frameId: z.string().min(1).optional(),
        ...returnSnapshotInput,
      },
      annotations: IDEMPOTENT_MUTATION,
    },
    async ({ target, checked, frameId, returnSnapshot }) => action({
      ...await browser.setChecked(target, checked, frameId, { returnSnapshot }),
      target,
    }),
  );

  registerTool(
    "press_key",
    {
      description: "Press a key in the current page, such as Enter, Escape, ArrowDown, or Control+A.",
      inputSchema: { key: z.string().min(1).max(100), ...returnSnapshotInput },
      annotations: MUTATING,
    },
    async ({ key, returnSnapshot }) => action({
      ...await browser.pressKey(key, { returnSnapshot }),
      key,
    }),
  );

  registerTool(
    "scroll",
    {
      description: "Scroll the current page; positive deltaY scrolls down and negative deltaY scrolls up.",
      inputSchema: {
        deltaX: z.number().finite().default(0),
        deltaY: z.number().finite(),
        ...returnSnapshotInput,
      },
      annotations: MUTATING,
    },
    async ({ deltaX, deltaY, returnSnapshot }) => action({
      ...await browser.scroll(deltaX, deltaY, { returnSnapshot }),
      deltaX,
      deltaY,
    }),
  );

  registerTool(
    "wait_for",
    {
      description: "Wait for one typed condition: element, text, URL glob, page load state, or duration.",
      inputSchema: {
        condition: waitConditionSchema,
        timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
        ...returnSnapshotInput,
      },
      annotations: READ_ONLY,
    },
    async ({ condition, timeoutMs, returnSnapshot }) => action({
      ...await browser.waitFor({ condition, timeoutMs }, { returnSnapshot }),
      kind: condition.kind,
    }),
  );

  if (config.uploadDirs.length > 0) {
    registerTool(
      "upload_file",
      {
        description:
          "Attach local files to a file input. Target the input[type=file] itself, by ref or "
          + "CSS selector; a hidden input works, so a styled upload button usually means "
          + "targeting the input it wraps. Paths must resolve inside a directory the server "
          + "was started with via --upload-dir. Registered only when --upload-dir is set.",
        inputSchema: {
          target: z.string().min(1),
          paths: z.array(z.string().min(1)).min(1).max(10),
          frameId: z.string().min(1).optional(),
          ...returnSnapshotInput,
        },
        annotations: MUTATING,
      },
      async ({ target, paths, frameId, returnSnapshot }) => action({
        ...await browser.uploadFile(target, paths, frameId, { returnSnapshot }),
        target,
      }),
    );
  }

  if (config.downloadDir) {
    registerTool(
      "list_downloads",
      {
        description:
          "List the downloads this session started: the name actually written, its size, and "
          + "state (saved, pending, failed). A large transfer is still pending when the action "
          + "that started it returns, so call this again to see it settle. Registered only when "
          + "--download-dir is set; without it downloads are reported on the action result as "
          + "discarded and nothing is written.",
        inputSchema: {},
        annotations: READ_ONLY,
      },
      async () => structured({ downloads: await browser.listDownloads() }),
    );
  }

  if (config.allowEval) {
    registerTool(
      "evaluate",
      {
        description: "Execute arbitrary JavaScript in the current page. This high-risk tool is registered only when --allow-eval is enabled.",
        inputSchema: { expression: z.string().min(1) },
        annotations: DESTRUCTIVE,
      },
      async ({ expression }) => text(await browser.evaluate(expression)),
    );
  }

  if (config.allowNativeAgent) {
    registerTool(
      "run_task",
      {
        description: "Delegate a complete goal to the native ChromiumFish browser agent. Requires an OpenAI-compatible endpoint configured through environment variables.",
        inputSchema: {
          task: z.string().min(1),
          url: z.url().optional(),
          maxSteps: z.number().int().min(1).max(100).default(25),
        },
        annotations: DESTRUCTIVE,
      },
      async ({ task, url, maxSteps }) => structured(await browser.runTask(task, url, maxSteps)),
    );
  }

  return server;
}
