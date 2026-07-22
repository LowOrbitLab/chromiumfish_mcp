import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
    takeScreenshot: async () => Buffer.from("png"),
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
    "list_frames",
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
