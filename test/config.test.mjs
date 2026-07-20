import assert from "node:assert/strict";
import test from "node:test";
import { parseCli, parseProxy, parseWindowSize } from "../dist/config.js";

test("解析完整 CLI 配置", () => {
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

test("拒绝越界窗口尺寸", () => {
  assert.throws(() => parseWindowSize("100x100"), /超出允许范围/);
  assert.throws(() => parseWindowSize("large"), /格式/);
});

test("代理凭据与服务地址分离", () => {
  assert.deepEqual(parseProxy("http://alice:p%40ss@127.0.0.1:8080"), {
    server: "http://127.0.0.1:8080",
    username: "alice",
    password: "p@ss",
  });
});
