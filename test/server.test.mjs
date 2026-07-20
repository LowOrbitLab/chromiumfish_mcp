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
};

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    status: async () => ({ running: false, pages: 0 }),
    listPages: async () => [],
    newPage: async () => ({ id: "page-1", current: true, title: "", url: "about:blank" }),
    selectPage: async (pageId) => ({ id: pageId, current: true, title: "Example", url: "https://example.com/" }),
    closePage: async () => undefined,
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
    snapshot: async (frameId) => {
      calls.push(["snapshot", frameId]);
      return "[e1] button \"Submit\"";
    },
    getText: async (frameId) => {
      calls.push(["getText", frameId]);
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
      widgetState: "absent",
      title: "Example",
      url: "https://example.com/",
      bodySnippet: "Example Domain",
      tokenPresent: false,
      frames: [{ url: "https://example.com/" }],
    }),
    clickChallenge: async () => ({
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
    }),
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

test("default tool set excludes dangerous tools", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("snapshot"));
  assert.ok(names.includes("list_pages"));
  assert.ok(names.includes("click_challenge"));
  assert.equal(names.includes("solve_turnstile"), false);
  assert.ok(names.includes("mouse_click"));
  assert.ok(names.includes("list_frames"));
  assert.ok(names.includes("find_challenge"));
  assert.ok(names.includes("go_forward"));
  assert.ok(names.includes("reload"));
  assert.ok(names.includes("hover"));
  assert.ok(names.includes("select_option"));
  assert.ok(names.includes("set_checked"));
  assert.equal(names.includes("eval_js"), false);
  assert.equal(names.includes("run_task"), false);
});

test("click_challenge and mouse_click return structured results", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const solved = await client.callTool({
    name: "click_challenge",
    arguments: { timeoutMs: 5000, maxClicks: 3 },
  });
  assert.match(solved.content[0].text, /already_clear/);
  const clicked = await client.callTool({
    name: "mouse_click",
    arguments: { x: 10, y: 20 },
  });
  assert.match(clicked.content[0].text, /"x": 10/);
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
  assert.match(withBox.content[0].text, /"frameId": "frame-1"/);
  const noBox = await client.callTool({
    name: "list_frames",
    arguments: { includeBox: false },
  });
  assert.doesNotMatch(noBox.content[0].text, /"width"/);
});

test("forwards frame, form, navigation, and wait arguments", async (context) => {
  const { browser, client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });

  await client.callTool({ name: "snapshot", arguments: { frameId: "frame-2" } });
  await client.callTool({ name: "get_text", arguments: { frameId: "frame-2" } });
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
  assert.match(selected.content[0].text, /United States/);
  const checked = await client.callTool({
    name: "set_checked",
    arguments: { target: "#terms", checked: true, frameId: "frame-2" },
  });
  assert.match(checked.content[0].text, /"checked": true/);
  await client.callTool({ name: "go_forward", arguments: {} });
  await client.callTool({ name: "reload", arguments: {} });
  await client.callTool({
    name: "wait_for",
    arguments: {
      text: "Complete",
      textState: "visible",
      frameId: "frame-2",
      timeoutMs: 5000,
    },
  });

  assert.deepEqual(browser.calls[0], ["snapshot", "frame-2"]);
  assert.deepEqual(browser.calls[1], ["getText", "frame-2"]);
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
  assert.equal(browser.calls[7][1].text, "Complete");
  assert.equal(browser.calls[7][1].frameId, "frame-2");
});

test("registers dangerous tools when explicitly enabled", async (context) => {
  const { client, server } = await connectedClient({ allowEval: true, allowNativeAgent: true });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("eval_js"));
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
});
