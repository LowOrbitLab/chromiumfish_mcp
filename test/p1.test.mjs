import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChromiumFishBrowser } from "../dist/browser.js";
import { createServer } from "../dist/server.js";

const config = {
  headless: true, windowSize: [800, 600], allowEval: false, allowNativeAgent: false,
  maxTextChars: 50_000, allowedHosts: [], uploadDirs: [],
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => "https://example.com/",
    title: async () => "Example",
    keyboard: { press: async () => undefined },
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    goto: async () => ({ status: () => 201 }),
  });
  const browser = new ChromiumFishBrowser(config);
  browser.currentPage = page;
  return { browser, page };
}

test("session runs operations serially and continues after a failure", { timeout: 2_000 }, async () => {
  const { browser, page } = fixture();
  const started = deferred();
  const release = deferred();
  const events = [];
  page.keyboard.press = async key => {
    events.push(key);
    if (key === "first") {
      started.resolve();
      await release.promise;
      throw new Error("first failed");
    }
  };
  const first = assert.rejects(browser.pressKey("first"), /first failed/);
  await started.promise;
  const second = browser.pressKey("second");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["first"]);
  release.resolve();
  await first;
  assert.equal((await second).ok, true);
  assert.deepEqual(events, ["first", "second"]);
});

test("follow-up snapshot re-enters the session lock, and its error does not mask action success", { timeout: 2_000 }, async () => {
  const { browser } = fixture();
  browser.snapshotOnce = async () => { throw new Error("snapshot unavailable"); };
  for (const result of [
    await browser.pressKey("Enter", { returnSnapshot: true }),
    await browser.navigate("https://example.com/", { returnSnapshot: true }),
  ]) {
    assert.equal(result.ok, true);
    assert.equal(result.snapshot, undefined);
    assert.equal(result.snapshotError, "snapshot unavailable");
  }
});

test("closing the session rejects operations not yet run", { timeout: 2_000 }, async () => {
  const { browser, page } = fixture();
  const started = deferred();
  const release = deferred();
  const events = [];
  page.keyboard.press = async key => {
    events.push(key);
    started.resolve();
    await release.promise;
  };
  const first = browser.pressKey("first");
  await started.promise;
  const second = assert.rejects(browser.pressKey("second"), /shutting down/);
  await browser.close();
  release.resolve();
  await first;
  await second;
  assert.deepEqual(events, ["first"]);
});

test("MCP keeps a completed action alongside a separate snapshot error", { timeout: 2_000 }, async t => {
  const { browser, page } = fixture();
  let presses = 0;
  page.keyboard.press = async () => { presses++; };
  browser.snapshotOnce = async () => { throw new Error("snapshot unavailable"); };
  const server = createServer(browser, config);
  const client = new Client({ name: "p1-regression", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); await browser.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: "press_key", arguments: { key: "Enter", returnSnapshot: true } });
  assert.equal(presses, 1);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.snapshotError, "snapshot unavailable");
  assert.equal(JSON.parse(result.content[0].text).snapshotError, "snapshot unavailable");
});

test("MCP call cancelled while queued never runs later", { timeout: 3_000 }, async t => {
  const { browser, page } = fixture();
  const started = deferred();
  const release = deferred();
  const events = [];
  page.keyboard.press = async key => {
    events.push(key);
    if (key === "first") {
      started.resolve();
      await release.promise;
    }
  };
  const server = createServer(browser, config);
  const client = new Client({ name: "p1-cancellation", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    release.resolve();
    await client.close();
    await server.close();
    await browser.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const first = client.callTool({ name: "press_key", arguments: { key: "first" } });
  await started.promise;
  const controller = new AbortController();
  const cancelled = client.callTool({ name: "press_key", arguments: { key: "cancelled" } }, undefined, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(cancelled, /abort|cancel/i);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await rejected;
  release.resolve();
  await first;
  await client.callTool({ name: "press_key", arguments: { key: "after" } });
  assert.deepEqual(events, ["first", "after"]);
});

test("concurrent same-name downloads allocate files atomically and keep every body", { timeout: 3_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "cfmcp-p1-download-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "report.txt"), "existing");
  const browser = new ChromiumFishBrowser({ ...config, downloadDir: root });
  const records = Array.from({ length: 8 }, () => ({ url: "", suggestedFilename: "report.txt", state: "pending" }));
  let disposed = 0;
  await Promise.all(records.map((record, index) => browser.saveDownload({
    createReadStream: async () => Readable.from([`content-${index}`]),
    delete: async () => { disposed++; },
  }, record)));
  assert.equal(new Set(records.map(record => record.file)).size, records.length);
  for (const [index, record] of records.entries()) {
    assert.equal(record.state, "saved", record.error);
    assert.equal(await readFile(join(root, record.file), "utf8"), `content-${index}`);
  }
  assert.equal(await readFile(join(root, "report.txt"), "utf8"), "existing");
  assert.equal(disposed, records.length);
});

test("failed download stream removes the partial file it created", { timeout: 3_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "cfmcp-p1-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const browser = new ChromiumFishBrowser({ ...config, downloadDir: root });
  const record = { url: "", suggestedFilename: "report.txt", state: "pending" };
  await browser.saveDownload({
    createReadStream: async () => Readable.from((async function* () {
      yield "partial";
      throw new Error("transfer failed");
    })()),
    delete: async () => undefined,
  }, record);
  assert.equal(record.state, "failed");
  assert.match(record.error, /transfer failed/);
  assert.deepEqual(await readdir(root), []);
});
