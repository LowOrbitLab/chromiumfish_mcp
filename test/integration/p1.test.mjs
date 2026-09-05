import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ChromiumFishBrowser } from "../../dist/browser.js";
import { createServer } from "../../dist/server.js";

const config = {
  headless: true, windowSize: [800, 600], allowEval: false, allowNativeAgent: false,
  maxTextChars: 50_000, allowedHosts: [], uploadDirs: [],
  chromePath: process.env.CHROME_BIN || chromium.executablePath(),
};

test("P1 real-browser regressions", { timeout: 55_000 }, async t => {
  const requests = [];
  const http = createHttpServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    requests.push({ host: url.hostname, path: url.pathname, method: req.method, cookie: req.headers.cookie });
    if (url.pathname === "/redirect") {
      res.writeHead(Number(url.searchParams.get("status") || 302), {
        location: url.searchParams.get("to") || `http://localhost:${http.address().port}/blocked`,
      });
      res.end();
    } else if (url.pathname === "/chain") {
      res.writeHead(302, { location: "/redirect" });
      res.end();
    } else if (url.pathname === "/cookie") {
      res.writeHead(302, { location: "/destination", "set-cookie": "session=local; Path=/" });
      res.end();
    } else if (url.pathname === "/download") {
      res.writeHead(200, { "content-disposition": 'attachment; filename="report.txt"' });
      res.end(url.searchParams.get("id") || "report");
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<title>Local fixture</title><p>Local fixture</p>");
    }
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  t.after(async () => {
    http.closeAllConnections();
    await new Promise(resolve => http.close(resolve));
  });

  await t.test("every redirect hop is allowlisted, and allowed hops keep cookies", async t => {
    const browser = new ChromiumFishBrowser({ ...config, allowedHosts: ["127.0.0.1"] });
    t.after(() => browser.close());
    for (const status of [301, 302, 303, 307, 308]) {
      const page = await browser.openPage();
      await assert.rejects(browser.navigate(`${base}/redirect?status=${status}`), /ERR_BLOCKED_BY_CLIENT/);
      await browser.closePage(page.pageId);
    }
    const page = await browser.openPage();
    await assert.rejects(browser.navigate(`${base}/chain`), /ERR_BLOCKED_BY_CLIENT/);
    await browser.closePage(page.pageId);
    assert.equal(requests.some(request => request.path === "/blocked"), false);
    const result = await browser.navigate(`${base}/cookie`);
    assert.equal(result.url, `${base}/destination`);
    assert.equal(result.status, 200);
    assert.match(requests.findLast(request => request.path === "/destination").cookie, /session=local/);
    assert.equal(await (await browser.page()).evaluate(async () => {
      await navigator.serviceWorker.register("/worker.js").catch(() => undefined);
      return (await navigator.serviceWorker.getRegistrations()).length;
    }), 0);
    assert.equal(requests.some(request => request.path === "/worker.js"), false);
  });

  await t.test("subframes still navigate cross-host, and popups cannot bypass the allowlist", async t => {
    const browser = new ChromiumFishBrowser({ ...config, allowedHosts: ["127.0.0.1"] });
    t.after(() => browser.close());
    await browser.navigate(base);
    const page = await browser.page();
    const frameUrl = `http://localhost:${http.address().port}/frame-destination`;
    await page.setContent(`<iframe src="${base}/redirect?to=${encodeURIComponent(frameUrl)}"></iframe>
      <button onclick="window.open('${base}/redirect')">Popup</button>`);
    await page.frameLocator("iframe").locator("p").waitFor({ timeout: 3_000 });
    assert.ok(requests.some(request => request.host === "localhost" && request.path === "/frame-destination"));
    await browser.click("button");
    await page.waitForTimeout(300);
    assert.equal(requests.some(request => request.path === "/blocked"), false);
  });

  await t.test("an occluded click never hits the overlay, and hits only the target once unblocked", async t => {
    const browser = new ChromiumFishBrowser(config);
    t.after(() => browser.close());
    await browser.navigate(base);
    const page = await browser.page();
    await page.setContent(`<button id="target" style="position:absolute;left:40px;top:40px;width:200px;height:80px"
      onclick="document.body.dataset.target='yes'">Target</button>
      <button id="overlay" style="position:absolute;left:40px;top:40px;width:200px;height:80px;z-index:100"
      onclick="document.body.dataset.overlay='yes'">Overlay</button>`);
    await assert.rejects(browser.click("#target"), /Timeout|intercepts pointer events/);
    assert.deepEqual(await page.evaluate(() => ({ ...document.body.dataset })), {});
    await page.locator("#overlay").evaluate(element => element.remove());
    assert.equal((await browser.click("#target")).ok, true);
    assert.deepEqual(await page.evaluate(() => ({ ...document.body.dataset })), { target: "yes" });
  });

  await t.test("concurrent MCP input never interleaves, and follow-up snapshots and page switches queue", async t => {
    const browser = new ChromiumFishBrowser(config);
    const server = createServer(browser, config);
    const client = new Client({ name: "p1-browser-regression", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); await browser.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await browser.navigate(base);
    const page = await browser.page();
    await page.setContent('<title>Form</title><input id="first"><br><input id="second">');
    const results = await Promise.all([
      client.callTool({ name: "type_text", arguments: { target: "#first", text: "aaaaaa", returnSnapshot: true } }),
      client.callTool({ name: "type_text", arguments: { target: "#second", text: "bbbbbb" } }),
      client.callTool({ name: "open_page", arguments: {} }),
    ]);
    assert.ok(results.every(result => !result.isError));
    assert.equal(results[0].content.length, 2);
    assert.deepEqual(await page.locator("input").evaluateAll(inputs => inputs.map(input => input.value)), ["aaaaaa", "bbbbbb"]);
    assert.notEqual(await browser.page(), page);
  });

  await t.test("same-name real downloads keep every file, and browser temp copies are cleaned up", async t => {
    const root = await mkdtemp(join(tmpdir(), "cfmcp-p1-live-"));
    const browser = new ChromiumFishBrowser({ ...config, downloadDir: root });
    t.after(async () => { await browser.close(); await rm(root, { recursive: true, force: true }); });
    await browser.navigate(base);
    const pages = await Promise.all([browser.context.newPage(), browser.context.newPage()]);
    for (const [index, page] of pages.entries()) {
      await page.setContent(`<a href="${base}/download?id=${index}">Download</a>`);
    }
    await Promise.all(pages.map(page => page.locator("a").click()));
    const deadline = Date.now() + 5_000;
    let records;
    do {
      records = await browser.listDownloads();
      if (records.length === 2 && records.every(record => record.state !== "pending")) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.equal(records.length, 2);
    assert.ok(records.every(record => record.state === "saved"), JSON.stringify(records));
    assert.equal(new Set(records.map(record => record.file)).size, 2);
    const contents = await Promise.all(records.map(record => readFile(join(root, record.file), "utf8")));
    assert.deepEqual(contents.sort(), ["0", "1"]);
  });
});
