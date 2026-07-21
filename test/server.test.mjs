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
  twoCaptchaForwardProxy: false,
  maxTextChars: 50_000,
  allowedHosts: [],
};

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    listPages: async () => ({ running: false, pages: [] }),
    newPage: async () => ({ pageId: "page-1", current: true, title: "", url: "about:blank" }),
    selectPage: async (pageId) => ({ pageId, current: true, title: "Example", url: "https://example.com/" }),
    closePage: async () => ({ running: true, pages: [] }),
    navigate: async (url) => ({ title: "Example", url }),
    goBack: async () => ({ title: "", url: "about:blank" }),
    goForward: async () => {
      calls.push(["goForward"]);
      return { title: "Forward", url: "https://example.com/forward" };
    },
    reload: async () => {
      calls.push(["reload"]);
      return { title: "Example", url: "https://example.com/" };
    },
    snapshot: async (options) => {
      calls.push(["snapshot", options]);
      return "[e1] button \"Submit\"";
    },
    getText: async (options) => {
      calls.push(["getText", options]);
      return "Page body";
    },
    screenshot: async () => Buffer.from("png"),
    click: async (target, frameId) => calls.push(["click", target, frameId]),
    hover: async (target, frameId) => calls.push(["hover", target, frameId]),
    selectOption: async (target, values, matchBy, frameId) => {
      calls.push(["selectOption", target, values, matchBy, frameId]);
      return values;
    },
    setChecked: async (target, checked, frameId) => {
      calls.push(["setChecked", target, checked, frameId]);
      return checked;
    },
    mouseClick: async (x, y) => ({ x, y, title: "Example", url: "https://example.com/" }),
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
      provider: "none",
      canSolve: false,
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
      provider: "none",
      kind: "none",
      elapsedMs: 1,
      applied: false,
      title: "Example",
      url: "https://example.com/",
      bodySnippet: "Example Domain",
      tokenPresent: false,
      };
    },
    typeText: async (target, value, clear, submit, frameId) => {
      calls.push(["typeText", target, value, clear, submit, frameId]);
    },
    pressKey: async () => undefined,
    scroll: async () => undefined,
    waitFor: async (options) => calls.push(["waitFor", options]),
    evalJs: async () => 42,
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

test("solve_challenge forwards 2Captcha options and click_at remains available", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const solved = await client.callTool({
    name: "solve_challenge",
    arguments: { timeoutMs: 10000, action: "login", minScore: 0.7 },
  });
  assert.match(solved.content[0].text, /already_clear/);
  assert.equal(solved.structuredContent.method, "already_clear");
  assert.deepEqual(browser.calls[0], ["solveChallenge", {
    timeoutMs: 10000,
    action: "login",
    minScore: 0.7,
  }]);
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
  assert.deepEqual(browser.calls[2], ["hover", "#menu", "frame-2"]);
  assert.deepEqual(browser.calls[3], [
    "selectOption",
    "#country",
    ["United States"],
    "label",
    "frame-2",
  ]);
  assert.deepEqual(browser.calls[4], ["setChecked", "#terms", true, "frame-2"]);
  assert.deepEqual(browser.calls[5], ["goForward"]);
  assert.deepEqual(browser.calls[6], ["reload"]);
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
