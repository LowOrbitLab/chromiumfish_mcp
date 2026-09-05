import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createServer } from "../dist/server.js";

const config = {
  headless: true,
  windowSize: [1920, 1080],
  allowEval: false,
  allowNativeAgent: false,
  maxTextChars: 50_000,
  allowedHosts: [],
  uploadDirs: [],
};

const SNAPSHOT_TEXT = "[e1] button \"Submit\"";

/** Mirror ChromiumFishBrowser's ActionResult contract, including the opt-in snapshot. */
function acted(options, extra = {}) {
  return {
    ok: true,
    url: "https://example.com/",
    title: "Example",
    navigated: false,
    ...(options?.returnSnapshot ? { snapshot: SNAPSHOT_TEXT } : {}),
    ...extra,
  };
}

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    listPages: async () => ({ running: false, pages: [] }),
    openPage: async () => ({ pageId: "page-1", current: true, title: "", url: "about:blank" }),
    selectPage: async (pageId) => ({ pageId, current: true, title: "Example", url: "https://example.com/" }),
    closePage: async () => ({ running: true, pages: [] }),
    // The navigation tools report the same shape as every other action, with
    // navigated unconditionally true.
    navigate: async (url, options) => {
      calls.push(["navigate", url, options]);
      return acted(options, { url, navigated: true });
    },
    navigateBack: async () => acted(undefined, { url: "about:blank", title: "", navigated: true }),
    navigateForward: async (options) => {
      calls.push(["navigateForward", options]);
      return acted(options, {
        url: "https://example.com/forward",
        title: "Forward",
        navigated: true,
      });
    },
    reload: async (options) => {
      calls.push(["reload", options]);
      return acted(options, { navigated: true });
    },
    snapshot: async (options) => {
      calls.push(["snapshot", options]);
      return "[e1] button \"Submit\"";
    },
    getText: async (options) => {
      calls.push(["getText", options]);
      return "Page body";
    },
    takeScreenshot: async (options) => {
      calls.push(["takeScreenshot", options]);
      return Buffer.from("png");
    },
    drag: async (target, destination, frameId, options) => {
      calls.push(["drag", target, destination, frameId, options]);
      return acted(options, { from: { x: 10, y: 20 }, to: { x: 210, y: 20 } });
    },
    click: async (target, frameId, options) => {
      calls.push(["click", target, frameId, options]);
      return acted(options, { navigated: true, newPages: ["page-2"] });
    },
    hover: async (target, frameId, options) => {
      calls.push(["hover", target, frameId, options]);
      return acted(options);
    },
    selectOption: async (target, values, matchBy, frameId, options) => {
      calls.push(["selectOption", target, values, matchBy, frameId, options]);
      return acted(options, { selectedValues: values });
    },
    setChecked: async (target, checked, frameId, options) => {
      calls.push(["setChecked", target, checked, frameId, options]);
      return acted(options, { checked });
    },
    uploadFile: async (target, paths, frameId, options) => {
      calls.push(["uploadFile", target, paths, frameId, options]);
      return acted(options, {
        files: paths.map((path) => ({ name: path.split("/").at(-1), bytes: 3 })),
      });
    },
    clickAt: async (x, y, options) => acted(options, { x, y }),
    listFrames: async (options) => {
      if (options?.includeBox === false) {
        return [{ frameId: "frame-1", url: "https://example.com/", name: "" }];
      }
      return [{
        frameId: "frame-1",
        url: "https://example.com/",
        name: "",
        box: { x: 0, y: 0, width: 100, height: 100 },
      }];
    },
    handleDialog: async (accept, promptText) => {
      calls.push(["handleDialog", accept, promptText]);
      return { pageId: "page-1", accept, ...(promptText === undefined ? {} : { promptText }) };
    },
    listDownloads: async () => {
      calls.push(["listDownloads"]);
      return [{
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        file: "report.pdf",
        bytes: 2048,
        state: "saved",
      }];
    },
    findChallenge: async () => ({
      present: false,
      kind: "none",
      widgetState: "absent",
      title: "Example",
      url: "https://example.com/",
      bodySnippet: "Example Domain",
      tokenPresent: false,
      frames: [{ url: "https://example.com/" }],
    }),
    solveChallenge: async (options) => {
      calls.push(["solveChallenge", options]);
      return {
        ok: true,
        method: "already_clear",
        challengeObserved: false,
        interactionPerformed: false,
        clearanceVerified: false,
        attempts: 0,
        elapsedMs: 1,
        title: "Example",
        url: "https://example.com/",
        bodySnippet: "Example Domain",
        widgetState: "absent",
        tokenPresent: false,
        clicks: [],
      };
    },
    typeText: async (target, value, clear, submit, frameId, options) => {
      calls.push(["typeText", target, value, clear, submit, frameId, options]);
      return acted(options);
    },
    pressKey: async (key, options) => acted(options),
    scroll: async (deltaX, deltaY, options) => acted(options),
    waitFor: async (options, actionOptions) => {
      calls.push(["waitFor", options, actionOptions]);
      return acted(actionOptions);
    },
    evaluate: async () => 42,
    runTask: async () => ({ success: true, finalText: "Completed", steps: 1 }),
    close: async () => undefined,
  };
}

async function connectedClient(overrides = {}) {
  const browser = fakeBrowser();
  const server = createServer(browser, { ...config, ...overrides });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { browser, client, server };
}

test("default tool set has a stable annotated contract", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "list_pages",
    "open_page",
    "select_page",
    "close_page",
    "navigate",
    "navigate_back",
    "navigate_forward",
    "reload",
    "snapshot",
    "get_text",
    "take_screenshot",
    "click",
    "hover",
    "click_at",
    "drag",
    "list_frames",
    "handle_dialog",
    "find_challenge",
    "solve_challenge",
    "type_text",
    "select_option",
    "set_checked",
    "press_key",
    "scroll",
    "wait_for",
  ]);
  assert.ok(tools.every((tool) => tool.annotations));
  assert.equal(tools.find((tool) => tool.name === "list_pages").annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === "close_page").annotations.destructiveHint, true);
});

test("solve_challenge and click_at return structured results", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const solved = await client.callTool({
    name: "solve_challenge",
    arguments: { timeoutMs: 5000, maxClicks: 3 },
  });
  assert.match(solved.content[0].text, /already_clear/);
  assert.equal(solved.structuredContent.method, "already_clear");
  assert.deepEqual(browser.calls[0], ["solveChallenge", { timeoutMs: 5000, maxClicks: 3 }]);
  const clicked = await client.callTool({
    name: "click_at",
    arguments: { x: 10, y: 20 },
  });
  assert.match(clicked.content[0].text, /"x":10/);
  assert.equal(clicked.structuredContent.x, 10);
});

test("solve_challenge forwards the same defaults the solver falls back to", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await client.callTool({ name: "solve_challenge", arguments: {} });
  // The schema default and ChromiumFishBrowser's own fallback both come from
  // SOLVE_TIMEOUT_MS / SOLVE_MAX_CLICKS; they used to disagree on the click budget.
  assert.deepEqual(browser.calls[0], ["solveChallenge", { timeoutMs: 45_000, maxClicks: 6 }]);
});

test("snapshot and get_text forward the same bounds the browser falls back to", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await client.callTool({ name: "snapshot", arguments: {} });
  await client.callTool({ name: "get_text", arguments: {} });
  // Both sides read SNAPSHOT_ELEMENTS / SNAPSHOT_CHARS / TEXT_CHARS, so a schema default
  // cannot drift away from the clamp ChromiumFishBrowser applies to the same argument.
  assert.deepEqual(browser.calls[0], ["snapshot", {
    frameId: undefined,
    scope: undefined,
    maxElements: 100,
    maxChars: 20_000,
  }]);
  assert.deepEqual(browser.calls[1], ["getText", {
    frameId: undefined,
    selector: undefined,
    maxChars: 20_000,
  }]);
});

test("list_frames supports includeBox", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const withBox = await client.callTool({
    name: "list_frames",
    arguments: { includeBox: true },
  });
  assert.match(withBox.content[0].text, /"width"/);
  assert.equal(withBox.structuredContent.frames[0].frameId, "frame-1");
  const noBox = await client.callTool({
    name: "list_frames",
    arguments: {},
  });
  assert.doesNotMatch(noBox.content[0].text, /"width"/);
});

test("forwards bounded inspection, form, navigation, and typed wait arguments", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  await client.callTool({
    name: "snapshot",
    arguments: { frameId: "frame-2", scope: "#dialog", maxElements: 25, maxChars: 8000 },
  });
  await client.callTool({
    name: "get_text",
    arguments: { frameId: "frame-2", selector: "main", maxChars: 5000 },
  });
  await client.callTool({
    name: "hover",
    arguments: { target: "#menu", frameId: "frame-2" },
  });
  const selected = await client.callTool({
    name: "select_option",
    arguments: {
      target: "#country",
      values: ["United States"],
      matchBy: "label",
      frameId: "frame-2",
    },
  });
  assert.deepEqual(selected.structuredContent.selectedValues, ["United States"]);
  const checked = await client.callTool({
    name: "set_checked",
    arguments: { target: "#terms", checked: true, frameId: "frame-2" },
  });
  assert.equal(checked.structuredContent.checked, true);
  await client.callTool({ name: "navigate_forward", arguments: {} });
  await client.callTool({ name: "reload", arguments: {} });
  await client.callTool({
    name: "wait_for",
    arguments: {
      condition: {
        kind: "text",
        text: "Complete",
        state: "visible",
        frameId: "frame-2",
      },
      timeoutMs: 5000,
    },
  });

  assert.deepEqual(browser.calls[0], ["snapshot", {
    frameId: "frame-2",
    scope: "#dialog",
    maxElements: 25,
    maxChars: 8000,
  }]);
  assert.deepEqual(browser.calls[1], ["getText", {
    frameId: "frame-2",
    selector: "main",
    maxChars: 5000,
  }]);
  assert.deepEqual(browser.calls[2], ["hover", "#menu", "frame-2", { returnSnapshot: false }]);
  assert.deepEqual(browser.calls[3], [
    "selectOption",
    "#country",
    ["United States"],
    "label",
    "frame-2",
    { returnSnapshot: false },
  ]);
  assert.deepEqual(browser.calls[4], [
    "setChecked",
    "#terms",
    true,
    "frame-2",
    { returnSnapshot: false },
  ]);
  assert.deepEqual(browser.calls[5], ["navigateForward", { returnSnapshot: false }]);
  assert.deepEqual(browser.calls[6], ["reload", { returnSnapshot: false }]);
  assert.equal(browser.calls[7][0], "waitFor");
  assert.equal(browser.calls[7][1].condition.text, "Complete");
  assert.equal(browser.calls[7][1].condition.frameId, "frame-2");
});

test("wait_for rejects legacy flat conditions at the MCP boundary", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: "wait_for",
    arguments: { text: "Complete", timeoutMs: 5000 },
  });
  assert.equal(result.isError, true);
});

test("wait_for accepts a JSON-string condition from clients that stringify objects", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: "wait_for",
    arguments: {
      condition: JSON.stringify({ kind: "text", text: "Ready", state: "visible" }),
      timeoutMs: 5000,
    },
  });
  assert.notEqual(result.isError, true);
  const call = browser.calls.find((entry) => entry[0] === "waitFor");
  assert.equal(call[1].condition.kind, "text");
  assert.equal(call[1].condition.text, "Ready");
});

test("registers dangerous tools when explicitly enabled", async (context) => {
  const { client, server } = await connectedClient({ allowEval: true, allowNativeAgent: true });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("evaluate"));
  assert.ok(names.includes("run_task"));
});

test("handle_dialog forwards the armed answer", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const accepted = await client.callTool({
    name: "handle_dialog",
    arguments: { accept: true, promptText: "Rebecka" },
  });
  assert.equal(accepted.structuredContent.accept, true);
  assert.equal(accepted.structuredContent.promptText, "Rebecka");
  assert.deepEqual(browser.calls[0], ["handleDialog", true, "Rebecka"]);

  await client.callTool({ name: "handle_dialog", arguments: { accept: false } });
  assert.deepEqual(browser.calls[1], ["handleDialog", false, undefined]);
});

test("list_downloads is registered only once --download-dir is set", async (context) => {
  const { client: bare, server: bareServer } = await connectedClient();
  context.after(async () => {
    await bare.close();
    await bareServer.close();
  });
  const withoutDir = (await bare.listTools()).tools.map((tool) => tool.name);
  assert.ok(!withoutDir.includes("list_downloads"));

  const { client, server } = await connectedClient({ downloadDir: "/tmp/downloads" });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("list_downloads"));

  const result = await client.callTool({ name: "list_downloads", arguments: {} });
  assert.deepEqual(result.structuredContent.downloads, [{
    url: "https://example.com/report.pdf",
    suggestedFilename: "report.pdf",
    file: "report.pdf",
    bytes: 2048,
    state: "saved",
  }]);
});

test("upload_file is registered and forwards its arguments once --upload-dir is set", async (context) => {
  const { browser, client, server } = await connectedClient({ uploadDirs: ["/tmp/uploads"] });
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("upload_file"));

  const result = await client.callTool({
    name: "upload_file",
    arguments: {
      target: "input[type=file]",
      paths: ["/tmp/uploads/a.png", "/tmp/uploads/b.png"],
      frameId: "frame-1",
    },
  });
  assert.deepEqual(browser.calls[0], [
    "uploadFile",
    "input[type=file]",
    ["/tmp/uploads/a.png", "/tmp/uploads/b.png"],
    "frame-1",
    { returnSnapshot: false },
  ]);
  assert.deepEqual(result.structuredContent.files, [
    { name: "a.png", bytes: 3 },
    { name: "b.png", bytes: 3 },
  ]);
  assert.equal(result.structuredContent.target, "input[type=file]");
});

test("initialize carries workflow instructions", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const instructions = client.getInstructions();
  assert.match(instructions, /Element references/);
  assert.match(instructions, /returnSnapshot/);
  assert.match(instructions, /solve_challenge ok: false is terminal/);
});

test("actions report page state so callers can skip a follow-up snapshot", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const clicked = await client.callTool({
    name: "click",
    arguments: { target: "e1" },
  });
  assert.deepEqual(clicked.structuredContent, {
    ok: true,
    url: "https://example.com/",
    title: "Example",
    navigated: true,
    newPages: ["page-2"],
    target: "e1",
  });
  assert.equal(clicked.content.length, 1);

  const typed = await client.callTool({
    name: "type_text",
    arguments: { target: "e2", text: "hello", submit: true },
  });
  assert.equal(typed.structuredContent.submitted, true);
  assert.equal(typed.structuredContent.navigated, false);

  const waited = await client.callTool({
    name: "wait_for",
    arguments: { condition: { kind: "load", state: "load" } },
  });
  assert.equal(waited.structuredContent.kind, "load");
  assert.equal(waited.structuredContent.url, "https://example.com/");

  // The navigation tools report the same fields. Omitting navigated here would read as
  // falsy - "the page did not move" - immediately after a navigation that cleared refs.
  const navigated = await client.callTool({
    name: "navigate",
    arguments: { url: "https://example.com/next" },
  });
  assert.deepEqual(navigated.structuredContent, {
    ok: true,
    url: "https://example.com/next",
    title: "Example",
    navigated: true,
  });
  const reloaded = await client.callTool({ name: "reload", arguments: {} });
  assert.equal(reloaded.structuredContent.ok, true);
  assert.equal(reloaded.structuredContent.navigated, true);
});

test("returnSnapshot appends a plain-text block and stays out of structuredContent", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const clicked = await client.callTool({
    name: "click",
    arguments: { target: "e1", returnSnapshot: true },
  });
  assert.deepEqual(browser.calls[0], ["click", "e1", undefined, { returnSnapshot: true }]);
  assert.equal(clicked.content.length, 2);
  // Raw newlines, not a JSON-escaped blob inside the state object.
  assert.equal(clicked.content[1].text, "[e1] button \"Submit\"");
  assert.equal(clicked.structuredContent.snapshot, undefined);
  assert.equal(clicked.structuredContent.navigated, true);

  const navigated = await client.callTool({
    name: "navigate",
    arguments: { url: "https://example.com/", returnSnapshot: true },
  });
  assert.equal(navigated.content.length, 2);
  assert.equal(navigated.content[1].text, "[e1] button \"Submit\"");
  assert.equal(navigated.structuredContent.snapshot, undefined);
});

test("tool calls return browser results", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({
    name: "navigate",
    arguments: { url: "https://example.com/" },
  });
  assert.match(result.content[0].text, /Example/);
  assert.equal(result.structuredContent.url, "https://example.com/");
});

test("drag forwards exactly one destination form", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const offset = await client.callTool({
    name: "drag",
    arguments: { target: "e1", dx: 200, dy: 0 },
  });
  assert.deepEqual(browser.calls[0], [
    "drag",
    "e1",
    { toTarget: undefined, dx: 200, dy: 0 },
    undefined,
    { returnSnapshot: false },
  ]);
  assert.deepEqual(offset.structuredContent.from, { x: 10, y: 20 });
  assert.deepEqual(offset.structuredContent.to, { x: 210, y: 20 });

  await client.callTool({
    name: "drag",
    arguments: { target: "#card", toTarget: "#column-2", frameId: "frame-1" },
  });
  assert.deepEqual(browser.calls[1], [
    "drag",
    "#card",
    { toTarget: "#column-2", dx: undefined, dy: undefined },
    "frame-1",
    { returnSnapshot: false },
  ]);
});

test("take_screenshot forwards the element crop", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "take_screenshot",
    arguments: { target: "e5", frameId: "frame-1" },
  });
  assert.deepEqual(browser.calls[0], [
    "takeScreenshot",
    { fullPage: false, target: "e5", frameId: "frame-1" },
  ]);
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/png");

  await client.callTool({ name: "take_screenshot", arguments: {} });
  assert.deepEqual(browser.calls[1], [
    "takeScreenshot",
    { fullPage: false, target: undefined, frameId: undefined },
  ]);
});

/**
 * The result contracts, described here rather than in the tool definitions.
 *
 * ActionResult is called a contract in four places — README, docs/USAGE.md, INSTRUCTIONS,
 * and the interface in browser.ts — and nothing checked that a tool actually returned it.
 * Declaring outputSchema on the tools themselves would have the SDK enforce it, but that
 * ships every shape to the client on tools/list: measured at 4,210 tokens without and
 * 10,912 with, a fixed 6.7k per session that most clients do not read. Checking it here
 * catches the same drift in CI and costs a caller nothing.
 *
 * Shapes are strict on purpose. A field the implementation gained but nobody documented is
 * exactly the drift worth failing on, so adding one has to touch this table too.
 */
const point = z.strictObject({ x: z.number(), y: z.number() });

const pageSummary = z.strictObject({
  pageId: z.string(),
  current: z.boolean(),
  title: z.string(),
  url: z.string(),
  status: z.number().int().optional(),
});

const pageList = z.strictObject({ running: z.boolean(), pages: z.array(pageSummary) });

const downloadRecord = z.strictObject({
  url: z.string(),
  suggestedFilename: z.string(),
  file: z.string().optional(),
  bytes: z.number().optional(),
  state: z.enum(["saved", "pending", "failed", "discarded"]),
  error: z.string().optional(),
});

/** Every mutating tool returns this, so a client never branches on which one it called. */
const ACTION = {
  ok: z.literal(true),
  url: z.string(),
  title: z.string(),
  navigated: z.boolean(),
  newPages: z.array(z.string()).optional(),
  navigationPending: z.boolean().optional(),
  navigationFailed: z.strictObject({ url: z.string(), reason: z.string() }).optional(),
  status: z.number().int().optional(),
  dialogs: z.array(z.strictObject({
    type: z.string(),
    message: z.string(),
    accepted: z.boolean(),
    promptText: z.string().optional(),
  })).optional(),
  dialogsOmitted: z.number().int().optional(),
  downloads: z.array(downloadRecord).optional(),
  snapshotError: z.string().optional(),
};

const TARGETED = { ...ACTION, target: z.string() };

const widgetState = z.enum(["absent", "checkbox", "verifying", "success", "unknown"]);
const widgetBox = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  frameUrl: z.string(),
});

/** Tool name -> the exact shape of its structuredContent. */
const RESULT_SHAPES = {
  list_pages: pageList,
  close_page: pageList,
  open_page: pageSummary,
  select_page: pageSummary,
  navigate: z.strictObject(ACTION),
  navigate_back: z.strictObject(ACTION),
  navigate_forward: z.strictObject(ACTION),
  reload: z.strictObject(ACTION),
  click: z.strictObject(TARGETED),
  hover: z.strictObject(TARGETED),
  click_at: z.strictObject({ ...ACTION, x: z.number(), y: z.number() }),
  drag: z.strictObject({ ...TARGETED, from: point, to: point }),
  type_text: z.strictObject({ ...TARGETED, submitted: z.boolean() }),
  select_option: z.strictObject({ ...TARGETED, selectedValues: z.array(z.string()) }),
  set_checked: z.strictObject({ ...TARGETED, checked: z.boolean() }),
  upload_file: z.strictObject({
    ...TARGETED,
    files: z.array(z.strictObject({ name: z.string(), bytes: z.number() })),
  }),
  press_key: z.strictObject({ ...ACTION, key: z.string() }),
  scroll: z.strictObject({ ...ACTION, deltaX: z.number(), deltaY: z.number() }),
  wait_for: z.strictObject({
    ...ACTION,
    kind: z.enum(["element", "text", "url", "load", "time"]),
  }),
  list_frames: z.strictObject({
    frames: z.array(z.strictObject({
      frameId: z.string(),
      parentFrameId: z.string().optional(),
      url: z.string(),
      name: z.string(),
      box: z.strictObject({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }).optional(),
    })),
  }),
  handle_dialog: z.strictObject({
    pageId: z.string(),
    accept: z.boolean(),
    promptText: z.string().optional(),
  }),
  list_downloads: z.strictObject({ downloads: z.array(downloadRecord) }),
  find_challenge: z.strictObject({
    present: z.boolean(),
    kind: z.enum(["none", "interstitial", "turnstile", "managed", "unknown"]),
    widgetState,
    title: z.string(),
    url: z.string(),
    bodySnippet: z.string(),
    tokenPresent: z.boolean(),
    widget: widgetBox.optional(),
    frames: z.array(z.strictObject({ url: z.string() })),
  }),
  solve_challenge: z.strictObject({
    ok: z.boolean(),
    method: z.enum(["already_clear", "self_cleared", "click", "not_found", "timeout", "busy"]),
    challengeObserved: z.boolean(),
    interactionPerformed: z.boolean(),
    clearanceVerified: z.boolean(),
    attempts: z.number().int(),
    elapsedMs: z.number(),
    title: z.string(),
    url: z.string(),
    bodySnippet: z.string(),
    widgetState,
    tokenPresent: z.boolean(),
    widget: widgetBox.optional(),
    clicks: z.array(point),
    reason: z.enum(["not_found", "stuck_verifying", "timeout", "busy"]).optional(),
    error: z.string().optional(),
  }),
  run_task: z.strictObject({
    success: z.boolean(),
    finalText: z.string(),
    steps: z.number().int(),
  }),
};

/** One valid call per tool, so the sweep below can reach every result shape. */
const CALL_ARGUMENTS = {
  list_pages: {},
  open_page: {},
  select_page: { pageId: "page-1" },
  close_page: {},
  navigate: { url: "https://example.com/" },
  navigate_back: {},
  navigate_forward: {},
  reload: {},
  snapshot: {},
  get_text: {},
  take_screenshot: {},
  click: { target: "e1" },
  hover: { target: "e1" },
  click_at: { x: 10, y: 20 },
  drag: { target: "e1", dx: 40, dy: 0 },
  list_frames: {},
  handle_dialog: { accept: true },
  find_challenge: {},
  solve_challenge: {},
  type_text: { target: "e1", text: "hello" },
  select_option: { target: "e1", values: ["us"] },
  set_checked: { target: "e1", checked: true },
  press_key: { key: "Enter" },
  scroll: { deltaY: 200 },
  wait_for: { condition: { kind: "time", timeMs: 0 } },
  upload_file: { target: "e1", paths: ["/tmp/a.txt"] },
  list_downloads: {},
  evaluate: { expression: "1 + 1" },
  run_task: { task: "book a table" },
};

test("every tool's structured result matches its declared shape", async (context) => {
  // Every gate open, so the sweep covers the config-gated tools too.
  const { client, server } = await connectedClient({
    allowEval: true,
    allowNativeAgent: true,
    uploadDirs: ["/tmp"],
    downloadDir: "/tmp",
  });
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  const missingArguments = tools.filter((tool) => !(tool.name in CALL_ARGUMENTS)).map((t) => t.name);
  assert.deepEqual(
    missingArguments,
    [],
    "a new tool needs an entry in CALL_ARGUMENTS, or the sweep silently skips it",
  );

  const unchecked = [];
  const failures = [];
  for (const tool of tools) {
    const result = await client.callTool({
      name: tool.name,
      arguments: CALL_ARGUMENTS[tool.name],
    });
    assert.ok(!result.isError, `${tool.name} returned an error: ${JSON.stringify(result.content)}`);
    // snapshot, get_text, evaluate return plain text and take_screenshot an image; those
    // carry no structured result to check.
    if (result.structuredContent === undefined) continue;
    const shape = RESULT_SHAPES[tool.name];
    if (!shape) {
      unchecked.push(tool.name);
      continue;
    }
    const parsed = shape.safeParse(result.structuredContent);
    if (!parsed.success) {
      failures.push(`${tool.name}: ${JSON.stringify(parsed.error.issues)}`);
    }
  }

  assert.deepEqual(failures, [], "a tool returned something its contract does not describe");
  assert.deepEqual(
    unchecked,
    [],
    "a tool returns structuredContent with no shape in RESULT_SHAPES; add one so the contract "
    + "four documents describe is actually enforced somewhere",
  );
});

test("the contract sweep fails when a result drifts from its shape", async (context) => {
  // The guard above is only worth having if it can fail, and a table of shapes that quietly
  // matches everything looks exactly like one that is working.
  const browser = fakeBrowser();
  browser.click = async () => ({
    ok: true,
    url: "https://example.com/",
    title: "Example",
    navigated: false,
    // Neither of these is in the contract: one renamed, one invented.
    navigationDone: true,
  });
  const server = createServer(browser, config);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({ name: "click", arguments: { target: "e1" } });
  const parsed = RESULT_SHAPES.click.safeParse(result.structuredContent);
  assert.equal(parsed.success, false);
});
