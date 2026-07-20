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
  return {
    status: async () => ({ running: false, pages: 0 }),
    listPages: async () => [],
    newPage: async () => ({ id: "page-1", current: true, title: "", url: "about:blank" }),
    selectPage: async (pageId) => ({ id: pageId, current: true, title: "Example", url: "https://example.com/" }),
    closePage: async () => undefined,
    navigate: async (url) => ({ title: "Example", url }),
    goBack: async () => ({ title: "", url: "about:blank" }),
    snapshot: async () => "[e1] button \"提交\"",
    getText: async () => "页面正文",
    screenshot: async () => Buffer.from("png"),
    click: async () => undefined,
    mouseClick: async (x, y) => ({ x, y, title: "Example", url: "https://example.com/" }),
    listFrames: async () => [{ url: "https://example.com/", name: "" }],
    detectChallenge: async () => ({
      present: false,
      kind: "none",
      widgetState: "absent",
      title: "Example",
      url: "https://example.com/",
      bodySnippet: "Example Domain",
      tokenPresent: false,
      frames: [{ url: "https://example.com/" }],
    }),
    solveTurnstile: async () => ({
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
    typeText: async () => undefined,
    pressKey: async () => undefined,
    scroll: async () => undefined,
    waitFor: async () => undefined,
    evalJs: async () => 42,
    runTask: async () => ({ success: true, finalText: "完成", steps: 1 }),
    close: async () => undefined,
  };
}

async function connectedClient(overrides = {}) {
  const server = createServer(fakeBrowser(), { ...config, ...overrides });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("默认工具集不包含危险工具", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("snapshot"));
  assert.ok(names.includes("list_pages"));
  assert.ok(names.includes("mouse_click"));
  assert.ok(names.includes("list_frames"));
  assert.ok(names.includes("detect_challenge"));
  assert.ok(names.includes("solve_turnstile"));
  assert.ok(!names.includes("eval_js"));
  assert.ok(!names.includes("run_task"));
});

test("solve_turnstile 与 mouse_click 返回结构化结果", async (context) => {
  const { client, server } = await connectedClient();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const solved = await client.callTool({
    name: "solve_turnstile",
    arguments: { timeoutMs: 5000, maxClicks: 3 },
  });
  assert.match(solved.content[0].text, /already_clear/);
  const clicked = await client.callTool({
    name: "mouse_click",
    arguments: { x: 10, y: 20 },
  });
  assert.match(clicked.content[0].text, /"x": 10/);
});

test("显式配置后注册危险工具", async (context) => {
  const { client, server } = await connectedClient({ allowEval: true, allowNativeAgent: true });
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("eval_js"));
  assert.ok(names.includes("run_task"));
});

test("工具调用返回浏览器结果", async (context) => {
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
