import assert from "node:assert/strict";
import test from "node:test";
import { ChromiumFishBrowser } from "../dist/browser.js";

const config = {
  headless: true,
  windowSize: [1280, 720],
  allowEval: false,
  allowNativeAgent: false,
  twoCaptchaForwardProxy: false,
  maxTextChars: 50_000,
  allowedHosts: [],
};

function frame({ url, name = "", parent = null, text = "", box } = {}) {
  return {
    url: () => url ?? "about:blank",
    name: () => name,
    parentFrame: () => parent,
    locator: () => ({
      boundingBox: async () => box,
      first: () => ({ innerText: async () => text }),
    }),
  };
}

test("listPages reports state without starting the browser and uses pageId", async () => {
  const browser = new ChromiumFishBrowser(config);
  assert.deepEqual(await browser.listPages(), { running: false, pages: [] });

  const page = {
    isClosed: () => false,
    title: async () => "Example",
    url: () => "https://example.com/",
  };
  browser.browser = { isConnected: () => true };
  browser.context = { pages: () => [page] };
  browser.currentPage = page;

  const result = await browser.listPages();
  assert.equal(result.running, true);
  assert.equal(result.pages[0].pageId, "page-1");
  assert.equal(result.pages[0].current, true);
});

test("closePage selects and reports a remaining page", async () => {
  let firstClosed = false;
  let secondFocused = false;
  const first = {
    isClosed: () => firstClosed,
    title: async () => "First",
    url: () => "https://example.com/first",
    close: async () => {
      firstClosed = true;
    },
  };
  const second = {
    isClosed: () => false,
    title: async () => "Second",
    url: () => "https://example.com/second",
    bringToFront: async () => {
      secondFocused = true;
    },
  };
  const browser = new ChromiumFishBrowser(config);
  browser.browser = { isConnected: () => true };
  browser.context = { pages: () => [first, second] };
  browser.currentPage = first;
  const before = await browser.listPages();

  const result = await browser.closePage(before.pages[0].pageId);
  assert.equal(secondFocused, true);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].pageId, "page-2");
  assert.equal(result.pages[0].current, true);
});

test("navigation guard blocks disallowed top-level requests only", async () => {
  const browser = new ChromiumFishBrowser({ ...config, allowedHosts: ["example.com"] });
  let handler;
  await browser.installNavigationGuard({
    route: async (pattern, callback) => {
      assert.equal(pattern, "**/*");
      handler = callback;
    },
  });

  function mockRoute(url, { navigation = true, topLevel = true, frameError = false } = {}) {
    const actions = [];
    return {
      actions,
      request: () => ({
        isNavigationRequest: () => navigation,
        url: () => url,
        frame: () => {
          if (frameError) throw new Error("Frame unavailable");
          return { parentFrame: () => topLevel ? null : {} };
        },
      }),
      continue: async () => actions.push("continue"),
      abort: async (reason) => actions.push(["abort", reason]),
    };
  }

  const allowed = mockRoute("https://app.example.com/dashboard");
  const blocked = mockRoute("https://example.net/redirected");
  const subframe = mockRoute("https://example.net/widget", { topLevel: false });
  const asset = mockRoute("https://example.net/app.js", { navigation: false });
  const unknownFrame = mockRoute("https://example.net/unknown", { frameError: true });
  await handler(allowed);
  await handler(blocked);
  await handler(subframe);
  await handler(asset);
  await handler(unknownFrame);

  assert.deepEqual(allowed.actions, ["continue"]);
  assert.deepEqual(blocked.actions, [["abort", "blockedbyclient"]]);
  assert.deepEqual(subframe.actions, ["continue"]);
  assert.deepEqual(asset.actions, ["continue"]);
  assert.deepEqual(unknownFrame.actions, [["abort", "blockedbyclient"]]);
});

test("listFrames returns stable frame IDs and blocks challenge DOM access", async () => {
  const main = frame({ url: "https://example.com/", text: "Main" });
  const child = frame({
    url: "https://widgets.example.net/form",
    name: "checkout",
    parent: main,
    text: "Card details",
    box: { x: 10, y: 20, width: 300, height: 180 },
  });
  const challenge = frame({
    url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/widget",
    parent: main,
  });
  const page = {
    frames: () => [main, child, challenge],
    mainFrame: () => main,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const first = await browser.listFrames({ includeBox: true });
  const second = await browser.listFrames({ includeBox: false });

  assert.equal(first[0].frameId, second[0].frameId);
  assert.equal(first[1].frameId, second[1].frameId);
  assert.equal(first[1].parentFrameId, first[0].frameId);
  assert.deepEqual(first[1].box, { x: 10, y: 20, width: 300, height: 180 });
  assert.equal(await browser.getText({ frameId: first[1].frameId }), "Card details");
  await assert.rejects(
    browser.getText({ frameId: first[2].frameId }),
    /DOM access to challenge frame/,
  );
});

test("getText surfaces explicit selector errors", async () => {
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({
      first: () => ({
        innerText: async () => {
          throw new Error("Invalid selector");
        },
      }),
    }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await assert.rejects(
    browser.getText({ selector: "[broken" }),
    /Invalid selector/,
  );
});

test("getText enforces the returned character budget", async () => {
  const main = frame({ url: "https://example.com/", text: "x".repeat(1000) });
  const page = {
    frames: () => [main],
    mainFrame: () => main,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const result = await browser.getText({ maxChars: 100 });
  assert.equal(result.length, 100);
  assert.match(result, /Content truncated/);
});

test("frame snapshot references support hover, selectOption, and setChecked", async () => {
  const main = frame({ url: "https://example.com/" });
  let checked = false;
  let selectedOptions;
  const moves = [];
  const child = {
    url: () => "https://widgets.example.net/form",
    name: () => "form",
    parentFrame: () => main,
  };
  const selectHandle = {
    isVisible: async () => true,
    evaluate: async (callback) => String(callback).includes("isConnected") ? true : ({
      role: "select",
      label: "Country",
      href: "",
      disabled: false,
      type: "",
      value: null,
      passwordSet: false,
      checked: null,
      selected: ["us"],
      selectedCount: 1,
      options: [
        { value: "us", label: "United States" },
        { value: "ca", label: "Canada" },
      ],
      optionCount: 2,
      expanded: null,
    }),
    ownerFrame: async () => child,
    dispose: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 30, y: 40, width: 160, height: 30 }),
    selectOption: async (options) => {
      selectedOptions = options;
      return ["ca"];
    },
  };
  const checkboxHandle = {
    isVisible: async () => true,
    evaluate: async (callback) => {
      const source = String(callback);
      if (source.includes("isConnected")) return true;
      if (source.includes("return element.type.toLowerCase")) return "checkbox";
      return {
        role: "input",
        label: "Accept terms",
        href: "",
        disabled: false,
        type: "checkbox",
        value: null,
        passwordSet: false,
        checked: false,
        selected: [],
        selectedCount: 0,
        options: [],
        optionCount: 0,
        expanded: null,
      };
    },
    ownerFrame: async () => child,
    dispose: async () => undefined,
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 30, y: 90, width: 20, height: 20 }),
    isChecked: async () => checked,
  };
  child.locator = () => ({
    elementHandles: async () => [selectHandle, checkboxHandle],
    first: () => ({ elementHandle: async () => selectHandle }),
  });
  const page = {
    frames: () => [main, child],
    mainFrame: () => main,
    mouse: {
      move: async (x, y) => moves.push({ x, y }),
      down: async () => undefined,
      up: async () => {
        checked = true;
      },
    },
    waitForTimeout: async () => undefined,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;
  const frames = await browser.listFrames({ includeBox: false });

  const snapshot = await browser.snapshot({ frameId: frames[1].frameId });
  assert.match(snapshot, /selected=\["us"\]/);
  assert.match(snapshot, /options=\[\{"value":"us","label":"United States"\}/);
  assert.match(snapshot, /type=checkbox unchecked/);

  await browser.hover("#country", frames[1].frameId);
  assert.ok(moves.length >= 4);
  assert.deepEqual(
    await browser.selectOption("e1", ["Canada"], "label"),
    ["ca"],
  );
  assert.deepEqual(selectedOptions, [{ label: "Canada" }]);
  assert.equal(await browser.setChecked("e2", true), true);
});

test("snapshot scans past hidden elements, reports truncation, and releases unused handles", async () => {
  const disposed = [];
  const makeHandle = (id, visible, label = "") => ({
    isVisible: async () => visible,
    evaluate: async () => ({
      role: "button",
      label,
      href: "",
      disabled: false,
      type: "",
      value: null,
      passwordSet: false,
      checked: null,
      selected: [],
      selectedCount: 0,
      options: [],
      optionCount: 0,
      expanded: null,
    }),
    dispose: async () => disposed.push(id),
  });
  let handles = [
    ...Array.from({ length: 251 }, (_, index) => makeHandle(index, false)),
    makeHandle(251, true, "Late visible control"),
    makeHandle(252, true, "Overflow control"),
  ];
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ elementHandles: async () => handles }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const result = await browser.snapshot({ maxElements: 1, maxChars: 5000 });
  assert.match(result, /Late visible control/);
  assert.match(result, /Snapshot truncated after 1 elements/);
  assert.equal(disposed.length, 252);

  handles = [];
  await browser.snapshot({ maxElements: 1, maxChars: 5000 });
  assert.equal(disposed.length, 253);
});

test("setChecked rejects unchecking a radio", async () => {
  const handle = {
    evaluate: async (callback) => String(callback).includes("isConnected") ? true : "radio",
    isChecked: async () => true,
  };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ first: () => ({ elementHandle: async () => handle }) }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await assert.rejects(
    browser.setChecked("#choice", false),
    /cannot be unchecked directly/,
  );
});

test("screenshots reject oversized documents and viewports", async () => {
  let captured = false;
  const page = {
    evaluate: async () => ({
      scale: 1,
      scrollWidth: 10_000,
      scrollHeight: 10_000,
      innerWidth: 10_000,
      innerHeight: 10_000,
    }),
    viewportSize: () => ({ width: 10_000, height: 10_000 }),
    screenshot: async () => {
      captured = true;
      return Buffer.from("png");
    },
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await assert.rejects(browser.screenshot(true), /too large/);
  await assert.rejects(browser.screenshot(false), /too large/);
  assert.equal(captured, false);
});

test("screenshot budget accounts for the device scale factor", async () => {
  let captured = false;
  const page = {
    evaluate: async () => ({
      scale: 2,
      scrollWidth: 4_000,
      scrollHeight: 4_000,
      innerWidth: 4_000,
      innerHeight: 4_000,
    }),
    viewportSize: () => ({ width: 4_000, height: 4_000 }),
    screenshot: async () => {
      captured = true;
      return Buffer.from("png");
    },
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  // 4000x4000 CSS px is 16M pixels, but at scale 2 the PNG is 8000x8000 = 64M px.
  await assert.rejects(browser.screenshot(true), /8000x8000/);
  assert.equal(captured, false);
});

test("goForward and reload wait for DOMContentLoaded", async () => {
  const calls = [];
  const page = {
    goForward: async (options) => calls.push(["goForward", options]),
    reload: async (options) => calls.push(["reload", options]),
    title: async () => "Example",
    url: () => "https://example.com/next",
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  assert.deepEqual(await browser.goForward(), {
    title: "Example",
    url: "https://example.com/next",
  });
  assert.deepEqual(await browser.reload(), {
    title: "Example",
    url: "https://example.com/next",
  });
  assert.deepEqual(calls, [
    ["goForward", { waitUntil: "domcontentloaded" }],
    ["reload", { waitUntil: "domcontentloaded" }],
  ]);
});

test("waitFor supports element, text, URL, load-state, and time conditions", async () => {
  const calls = [];
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: (selector) => ({
      first: () => ({
        waitFor: async (options) => calls.push(["element", selector, options]),
      }),
    }),
    getByText: (value, options) => ({
      filter: (filterOptions) => ({
        first: () => ({
          waitFor: async (waitOptions) => calls.push([
            "text",
            value,
            options,
            filterOptions,
            waitOptions,
          ]),
        }),
      }),
    }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    waitForURL: async (url, options) => calls.push(["url", url, options]),
    waitForLoadState: async (state, options) => calls.push(["load", state, options]),
    waitForTimeout: async (timeMs) => calls.push(["time", timeMs]),
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await browser.waitFor({
    condition: { kind: "element", target: "#ready", state: "visible" },
    timeoutMs: 1000,
  });
  await browser.waitFor({
    condition: { kind: "text", text: "Complete", state: "hidden" },
    timeoutMs: 2000,
  });
  await browser.waitFor({
    condition: { kind: "url", url: "**/dashboard" },
    timeoutMs: 3000,
  });
  await browser.waitFor({
    condition: { kind: "load", state: "networkidle" },
    timeoutMs: 4000,
  });
  await browser.waitFor({
    condition: { kind: "time", timeMs: 250 },
    timeoutMs: 5000,
  });

  assert.deepEqual(calls.map((entry) => entry[0]), ["element", "text", "url", "load", "time"]);
  assert.equal(calls[0][2].state, "visible");
  assert.deepEqual(calls[1][3], { visible: true });
  assert.equal(calls[1][4].state, "detached");
  assert.equal(calls[2][1], "**/dashboard");
  assert.equal(calls[3][1], "networkidle");
  assert.equal(calls[4][1], 250);
});

test("solveChallenge sends the detected target to 2Captcha and applies the token", async () => {
  const calls = [];
  let applied = false;
  const solver = {
    solve: async (target, options) => {
      calls.push([target, options]);
      return { taskId: "task-1", token: "solution-token", cost: "0.003" };
    },
  };
  const browser = new ChromiumFishBrowser(config, solver);
  const detection = {
    present: true,
    kind: "hcaptcha",
    provider: "hcaptcha",
    canSolve: true,
    title: "Captcha",
    url: "https://example.com/form",
    bodySnippet: "Verify",
    tokenPresent: false,
    siteKey: "h-site-key",
    frames: [],
  };
  const target = {
    provider: "hcaptcha",
    kind: "hcaptcha",
    siteKey: "h-site-key",
    pageUrl: "https://example.com/form",
    userAgent: "TestAgent/1.0",
  };
  const page = {
    waitForTimeout: async () => undefined,
    isClosed: () => false,
  };
  browser.page = async () => page;
  browser.inspectChallenge = async () => applied
    ? {
        detection: {
          ...detection,
          present: false,
          kind: "none",
          provider: "none",
          canSolve: false,
          tokenPresent: true,
        },
      }
    : { detection, target };
  browser.applyChallengeSolution = async (_page, appliedTarget, token) => {
    calls.push([appliedTarget, token]);
    applied = true;
    return { applied: true, callbackInvoked: true, fieldsUpdated: 1 };
  };

  const result = await browser.solveChallenge({ timeoutMs: 10_000, action: "checkout" });
  assert.equal(result.ok, true);
  assert.equal(result.method, "2captcha");
  assert.equal(result.taskId, "task-1");
  assert.equal(result.tokenPresent, true);
  assert.equal(result.callbackInvoked, true);
  assert.equal(result.fieldsUpdated, 1);
  assert.equal(calls[0][0].action, "checkout");
  assert.equal(calls[1][1], "solution-token");
});

test("solveChallenge returns a configuration error without an API key", async () => {
  const browser = new ChromiumFishBrowser(config);
  const detection = {
    present: true,
    kind: "turnstile",
    provider: "turnstile",
    canSolve: true,
    title: "Captcha",
    url: "https://example.com/form",
    bodySnippet: "Verify",
    tokenPresent: false,
    siteKey: "0x4AAAA",
    frames: [],
  };
  browser.page = async () => ({ waitForTimeout: async () => undefined });
  browser.inspectChallenge = async () => ({
    detection,
    target: {
      provider: "turnstile",
      kind: "turnstile",
      siteKey: "0x4AAAA",
      pageUrl: "https://example.com/form",
      userAgent: "TestAgent/1.0",
    },
  });

  const result = await browser.solveChallenge({ timeoutMs: 10_000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "API_KEY_MISSING");
  assert.doesNotMatch(result.error, /[a-f0-9]{32}/i);
});
