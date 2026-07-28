/**
 * Live integration smoke for dialogs, HTTP status, and downloads.
 * Not part of npm test (launches a browser); needs no network — it serves its own fixture.
 *
 * Usage:
 *   CHROME_BIN=/path/to/chrome node scripts/live-dialogs-downloads.mjs
 *
 * The unit suite drives these paths through fakes, which cannot answer the questions that
 * matter here: whether a dismissed confirm really leaves the page untouched, and what
 * Chromium hands over as a download's suggested name when the server picks a hostile one.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromiumFishBrowser } from "../dist/browser.js";

const PAGE = `<!doctype html><title>Dialog fixture</title>
<button id="confirm-btn" onclick="document.getElementById('out').textContent =
  confirm('Delete everything?') ? 'confirmed' : 'cancelled'">Delete</button>
<button id="prompt-btn" onclick="document.getElementById('out').textContent =
  'name=' + prompt('Your name?')">Name</button>
<a id="dl" href="/report.pdf" download>Download</a>
<p id="out">untouched</p>`;

const http = createServer((req, res) => {
  if (req.url === "/missing") {
    // Answers 404 with something that reads exactly like a real page, which is the case
    // status exists for.
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<title>Not found</title><p>No such page, but it looks like one.</p>");
    return;
  }
  if (req.url === "/report.pdf") {
    // What a hostile server would send: traversal plus a character Windows forbids.
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": 'attachment; filename="../../../evil:name.pdf"',
    });
    res.end("%PDF-1.4 fake");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${http.address().port}`;

const downloadDir = await mkdtemp(join(tmpdir(), "cfmcp-live-"));
const chromePath = process.env.CHROME_BIN || undefined;
const browser = new ChromiumFishBrowser({
  headless: true,
  windowSize: [1280, 720],
  allowEval: false,
  allowNativeAgent: false,
  maxTextChars: 50_000,
  allowedHosts: [],
  uploadDirs: [],
  downloadDir,
  ...(chromePath ? { chromePath } : {}),
});

const results = [];
const check = async (name, run) => {
  try {
    await run();
    results.push(`  ok   ${name}`);
  } catch (error) {
    results.push(`  FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

try {
  const missing = await browser.navigate(`${base}/missing`);
  await check("404 is reported as a status, not as a successful page", () => {
    assert.equal(missing.status, 404);
  });
  await check("200 is reported", async () => {
    assert.equal((await browser.navigate(base)).status, 200);
  });

  const dismissed = await browser.click("#confirm-btn");
  await check("an unarmed confirm is dismissed and reported", () => {
    assert.deepEqual(dismissed.dialogs, [
      { type: "confirm", message: "Delete everything?", accepted: false },
    ]);
  });
  await check("the page agrees nothing was deleted", async () => {
    assert.equal(await browser.getText({ selector: "#out" }), "cancelled");
  });

  await browser.handleDialog(true);
  const accepted = await browser.click("#confirm-btn");
  await check("an armed confirm is accepted", () => {
    assert.equal(accepted.dialogs[0].accepted, true);
  });
  await check("the page agrees the delete went through", async () => {
    assert.equal(await browser.getText({ selector: "#out" }), "confirmed");
  });

  const second = await browser.click("#confirm-btn");
  await check("the arm was consumed by exactly one dialog", () => {
    assert.equal(second.dialogs[0].accepted, false);
  });

  await browser.handleDialog(true, "Rebecka");
  await browser.click("#prompt-btn");
  await check("promptText reaches the page", async () => {
    assert.equal(await browser.getText({ selector: "#out" }), "name=Rebecka");
  });

  const downloaded = await browser.click("#dl");
  await check("the download is reported on the action that started it", () => {
    assert.equal(downloaded.downloads?.length, 1);
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [record] = await browser.listDownloads();
    if (record && record.state !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const [record] = await browser.listDownloads();
  const onDisk = await readdir(downloadDir);
  await check("the download landed under a name safe to write", () => {
    assert.equal(record.state, "saved", record.error ?? "");
    // Chromium normalizes the server's name before Playwright sees it — measured, it
    // arrives as "_.._.._evil_name.pdf" — so what matters here is that whatever arrives
    // ends up as a single file inside the root, not scattered up the directory tree.
    assert.deepEqual(onDisk, [record.file]);
    assert.ok(!record.file.includes("/") && !record.file.includes("\\"));
  });
  await check("the bytes actually landed", async () => {
    assert.equal(await readFile(join(downloadDir, record.file), "utf8"), "%PDF-1.4 fake");
  });
  results.push(`  -- suggested: ${JSON.stringify(record.suggestedFilename)} -> written: ${JSON.stringify(record.file)}`);
} catch (error) {
  results.push(`  FAIL (threw) ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  http.close();
  await rm(downloadDir, { recursive: true, force: true });
  console.log(results.join("\n"));
  console.log(process.exitCode ? "\nLIVE CHECK FAILED" : "\nlive check passed");
}
