import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import test from "node:test";
import { HELP, parseAllowedHost, parseCli, parseProxy, parseWindowSize, VERSION } from "../dist/config.js";

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
  assert.equal(config.timezone, "Asia/Shanghai");
  assert.deepEqual(config.allowedHosts, ["example.com"]);
  assert.equal(config.allowEval, true);
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

test("collects --upload-dir roots as absolute paths", () => {
  const { config } = parseCli(["--upload-dir", "fixtures", "--upload-dir", "docs"]);
  assert.equal(config.uploadDirs.length, 2);
  // Absolute at parse time so a later cwd change cannot move the root.
  for (const dir of config.uploadDirs) assert.equal(isAbsolute(dir), true);
  assert.equal(config.uploadDirs[0], resolve("fixtures"));
  assert.equal(config.uploadDirs[1], resolve("docs"));
});

test("leaves uploads disabled without --upload-dir", () => {
  assert.deepEqual(parseCli([]).config.uploadDirs, []);
  assert.throws(() => parseCli(["--upload-dir"]), /requires a value/);
});

test("rejects --allowed-host forms that would silently match nothing", () => {
  // Every one of these compares against something URL.hostname never contains, so the guard
  // would block all navigation while looking configured.
  assert.throws(() => parseCli(["--allowed-host", "localhost:3000"]), /must not include a port/);
  assert.throws(() => parseCli(["--allowed-host", "https://example.com"]), /not a URL/);
  assert.throws(() => parseCli(["--allowed-host", "example.com/app"]), /not a URL/);
  assert.throws(() => parseCli(["--allowed-host", ".example.com"]), /must not start with a dot/);
  assert.throws(() => parseCli(["--allowed-host", "*.example.com"]), /does not support wildcards/);

  assert.equal(parseAllowedHost("  EXAMPLE.com  "), "example.com");
  // A bracketed IPv6 literal is the form hostname reports, so its colons are legal.
  assert.equal(parseAllowedHost("[::1]"), "[::1]");
  assert.deepEqual(parseCli(["--allowed-host", "Example.COM"]).config.allowedHosts, ["example.com"]);
});

test("VERSION tracks package.json", async () => {
  // config.ts holds VERSION by hand and it reaches clients through the MCP handshake, so a
  // release that forgot to update one of the two would report the wrong server version.
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.ok(HELP.startsWith(`chromiumfish_mcp ${pkg.version}`), "--help reports the same version");
});

test("separates proxy credentials from the server URL", () => {
  assert.deepEqual(parseProxy("http://alice:p%40ss@127.0.0.1:8080"), {
    server: "http://127.0.0.1:8080",
    username: "alice",
    password: "p@ss",
  });
});
