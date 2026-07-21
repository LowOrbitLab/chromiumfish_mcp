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
    "--proxy", "http://alice:secret@127.0.0.1:8080",
    "--2captcha-forward-proxy",
    "--allow-eval",
  ]);
  assert.equal(config.personaSeed, "alice");
  assert.equal(config.chromePath, "C:/browser/chrome.exe");
  assert.equal(config.browserVersion, "149.0.7827.115");
  assert.equal(config.headless, false);
  assert.deepEqual(config.windowSize, [1440, 900]);
  assert.equal(config.timezone, "Asia/Shanghai");
  assert.deepEqual(config.allowedHosts, ["example.com"]);
  assert.equal(config.allowEval, true);
  assert.equal(config.twoCaptchaForwardProxy, true);
});

function withChromeBin(value, run) {
  const saved = process.env.CHROME_BIN;
  if (value === undefined) delete process.env.CHROME_BIN;
  else process.env.CHROME_BIN = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = saved;
  }
}

test("defaults the timezone to auto", () => {
  withChromeBin(undefined, () => {
    const { config } = parseCli([]);
    assert.equal(config.timezone, "auto");
  });
});

test("does not default to auto when --chrome-path is used", () => {
  const { config } = parseCli(["--chrome-path", "C:/browser/chrome.exe"]);
  assert.equal(config.timezone, undefined);
});

test("does not default to auto when CHROME_BIN is set", () => {
  withChromeBin("C:/browser/chrome.exe", () => {
    const { config } = parseCli([]);
    assert.equal(config.chromePath, "C:/browser/chrome.exe");
    assert.equal(config.timezone, undefined);
  });
});

test("treats --timezone system as no override", () => {
  withChromeBin(undefined, () => {
    const { config } = parseCli(["--timezone", "system"]);
    assert.equal(config.timezone, undefined);
  });
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

test("reads the 2Captcha key only from the environment", () => {
  const saved = process.env.TWOCAPTCHA_API_KEY;
  process.env.TWOCAPTCHA_API_KEY = "  test-key  ";
  try {
    const { config } = parseCli([]);
    assert.equal(config.twoCaptchaApiKey, "test-key");
  } finally {
    if (saved === undefined) delete process.env.TWOCAPTCHA_API_KEY;
    else process.env.TWOCAPTCHA_API_KEY = saved;
  }
});

test("requires a browser proxy before forwarding it to 2Captcha", () => {
  assert.throws(
    () => parseCli(["--2captcha-forward-proxy"]),
    /requires --proxy/,
  );
});
