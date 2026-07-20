import assert from "node:assert/strict";
import test from "node:test";
import { parseCli, parseProxy, parseWindowSize } from "../dist/config.js";

test("parses a complete CLI configuration", () => {
  const { config } = parseCli([
    "--persona-seed", "alice",
    "--chrome-path", "C:/browser/chrome.exe",
    "--browser-version", "149.0.7827.115",
    "--headed",
    "--window-size", "1440x900",
    "--timezone", "Asia/Shanghai",
    "--allowed-host", "example.com",
    "--allow-eval",
  ]);
  assert.equal(config.personaSeed, "alice");
  assert.equal(config.chromePath, "C:/browser/chrome.exe");
  assert.equal(config.browserVersion, "149.0.7827.115");
  assert.equal(config.headless, false);
  assert.deepEqual(config.windowSize, [1440, 900]);
  assert.deepEqual(config.allowedHosts, ["example.com"]);
  assert.equal(config.allowEval, true);
});

test("rejects out-of-range window sizes", () => {
  assert.throws(() => parseWindowSize("100x100"), /between/);
  assert.throws(() => parseWindowSize("large"), /format/);
});

test("separates proxy credentials from the server URL", () => {
  assert.deepEqual(parseProxy("http://alice:p%40ss@127.0.0.1:8080"), {
    server: "http://127.0.0.1:8080",
    username: "alice",
    password: "p@ss",
  });
});
