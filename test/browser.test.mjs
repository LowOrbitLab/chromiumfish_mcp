import assert from "node:assert/strict";
import test from "node:test";
import { ChromiumFishBrowser } from "../dist/browser.js";

const config = {
  headless: true,
  windowSize: [1280, 720],
  allowEval: false,
  allowNativeAgent: false,
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
      tag: "select",
      explicitRole: "",
      hasList: false,
      multiple: false,
      size: 0,
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
        tag: "input",
        explicitRole: "",
        hasList: false,
        multiple: false,
        size: 0,
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
    url: () => "https://example.com/",
    title: async () => "Example",
    mouse: {
      move: async (x, y) => moves.push({ x, y }),
      down: async () => undefined,
      up: async () => {
        checked = true;
      },
    },
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;
  const frames = await browser.listFrames({ includeBox: false });

  const snapshot = await browser.snapshot({ frameId: frames[1].frameId });
  assert.match(snapshot, /selected=\["us"\]/);
  assert.match(snapshot, /options=\[\{"value":"us","label":"United States"\}/);
  assert.match(snapshot, /type=checkbox unchecked/);
  // Roles are printed as ARIA roles so they can be reused in a role= selector.
  assert.match(snapshot, /^\[e1\] combobox "Country"/m);
  assert.match(snapshot, /^\[e2\] checkbox "Accept terms"/m);

  await browser.hover("#country", frames[1].frameId);
  assert.ok(moves.length >= 4);
  const selected = await browser.selectOption("e1", ["Canada"], "label");
  assert.deepEqual(selected.selectedValues, ["ca"]);
  assert.equal(selected.navigated, false);
  assert.deepEqual(selectedOptions, [{ label: "Canada" }]);
  const set = await browser.setChecked("e2", true);
  assert.equal(set.checked, true);
  assert.equal(set.url, "https://example.com/");
});

test("actions report navigation, opened pages, and an opt-in snapshot", async () => {
  let currentUrl = "https://example.com/form";
  let pages;
  const popup = {
    isClosed: () => false,
    once: () => undefined,
    title: async () => "Popup",
    url: () => "https://example.com/popup",
  };
  const handle = {
    evaluate: async () => true,
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 10, width: 40, height: 20 }),
  };
  const main = {
    url: () => currentUrl,
    name: () => "",
    parentFrame: () => null,
    locator: () => ({
      elementHandles: async () => [],
      first: () => ({ elementHandle: async () => handle }),
    }),
  };
  const opened = {
    isClosed: () => false,
    once: () => undefined,
    title: async () => "Opened",
    url: () => "https://example.com/opened",
  };
  const page = {
    isClosed: () => false,
    once: () => undefined,
    frames: () => [main],
    mainFrame: () => main,
    url: () => currentUrl,
    title: async () => "Done",
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    goto: async () => {
      // The load both moves the page and opens a tab.
      currentUrl = "https://example.com/landing";
      pages = [page, popup, opened];
    },
    mouse: {
      move: async () => undefined,
      down: async () => undefined,
      up: async () => {
        // The click both navigates the current page and opens a tab.
        currentUrl = "https://example.com/done";
        pages = [page, popup];
      },
    },
  };
  pages = [page];

  const browser = new ChromiumFishBrowser(config);
  browser.browser = { isConnected: () => true };
  browser.context = { pages: () => pages };
  browser.page = async () => page;
  await browser.listPages();

  const clicked = await browser.click("#submit");
  assert.equal(clicked.ok, true);
  assert.equal(clicked.navigated, true);
  assert.equal(clicked.url, "https://example.com/done");
  assert.equal(clicked.title, "Done");
  assert.deepEqual(clicked.newPages, ["page-2"]);
  assert.equal(clicked.snapshot, undefined);

  const settled = await browser.click("#submit", undefined, { returnSnapshot: true });
  assert.equal(settled.navigated, false);
  assert.equal(settled.newPages, undefined);
  assert.equal(settled.snapshot, "(No visible interactive elements)");

  // The navigation tools report the same shape. A missing navigated field would read as
  // falsy - "the page did not move" - right after the call that invalidated every ref.
  const moved = await browser.navigate("https://example.com/landing");
  assert.equal(moved.ok, true);
  assert.equal(moved.navigated, true);
  assert.equal(moved.url, "https://example.com/landing");
  assert.equal(moved.title, "Done");
  assert.deepEqual(moved.newPages, ["page-3"]);
});

test("snapshot scans past hidden elements, reports truncation, and releases unused handles", async () => {
  const disposed = [];
  const makeHandle = (id, visible, label = "") => ({
    isVisible: async () => visible,
    evaluate: async () => ({
      tag: "button",
      explicitRole: "",
      hasList: false,
      multiple: false,
      size: 0,
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

test("element targeting bounds Playwright's otherwise unlimited auto-wait", async () => {
  const seen = {};
  const handle = {
    evaluate: async () => true,
    scrollIntoViewIfNeeded: async (options) => {
      seen.scroll = options;
    },
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    selectOption: async (values, options) => {
      seen.select = options;
      return ["ca"];
    },
  };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({
      first: () => ({
        elementHandle: async (options) => {
          seen.resolve = options;
          return handle;
        },
      }),
    }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    url: () => "https://example.com/",
    title: async () => "Example",
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    mouse: {
      move: async () => undefined,
      down: async () => undefined,
      up: async () => undefined,
    },
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await browser.selectOption("#country", ["ca"], "value");
  await browser.hover("#country");

  // Assert the bound exists rather than its exact value; 0/undefined means "wait forever".
  for (const [name, options] of Object.entries(seen)) {
    assert.ok(
      options?.timeout > 0 && options.timeout <= 10_000,
      `${name} auto-wait is unbounded: ${JSON.stringify(options)}`,
    );
  }
  assert.deepEqual(Object.keys(seen).sort(), ["resolve", "scroll", "select"]);
});

test("reference numbers are never reused, so a stale reference fails loudly", async () => {
  const makeHandle = (label) => ({
    isVisible: async () => true,
    evaluate: async () => ({
      tag: "button",
      explicitRole: "",
      hasList: false,
      multiple: false,
      size: 0,
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
    dispose: async () => undefined,
  });
  let handles = [makeHandle("First")];
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ elementHandles: async () => handles }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    url: () => "https://example.com/",
    title: async () => "Example",
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const first = await browser.snapshot();
  assert.match(first, /^\[e1\] button "First"/);

  handles = [makeHandle("Second")];
  const second = await browser.snapshot();
  // A second snapshot must not hand out e1 again, or a remembered e1 would silently
  // resolve to a different element.
  assert.match(second, /^\[e2\] button "Second"/);

  await assert.rejects(
    browser.click("e1"),
    /Unknown element reference e1; the current snapshot of this page covers e2-e2/,
  );
  await assert.rejects(
    browser.waitFor({ condition: { kind: "element", target: "e1" }, timeoutMs: 1000 }),
    /Reference numbers are never reused/,
  );
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

test("takeScreenshot rejects oversized documents and viewports", async () => {
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

  await assert.rejects(browser.takeScreenshot(true), /too large/);
  await assert.rejects(browser.takeScreenshot(false), /too large/);
  assert.equal(captured, false);
});

test("takeScreenshot budget accounts for the device scale factor", async () => {
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
  await assert.rejects(browser.takeScreenshot(true), /8000x8000/);
  assert.equal(captured, false);
});

test("navigateForward and reload wait for DOMContentLoaded", async () => {
  const calls = [];
  const page = {
    goForward: async (options) => calls.push(["goForward", options]),
    reload: async (options) => calls.push(["reload", options]),
    title: async () => "Example",
    url: () => "https://example.com/next",
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  assert.deepEqual(await browser.navigateForward(), {
    ok: true,
    title: "Example",
    url: "https://example.com/next",
    navigated: true,
  });
  assert.deepEqual(await browser.reload(), {
    ok: true,
    title: "Example",
    url: "https://example.com/next",
    navigated: true,
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
    url: () => "https://example.com/",
    title: async () => "Example",
    waitForURL: async (url, options) => calls.push(["url", url, options]),
    waitForLoadState: async (state, options) => calls.push(["load", state, options]),
    waitForTimeout: async (timeMs) => calls.push(["time", timeMs]),
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  /** Run one condition and drop the trailing settle every action shares. */
  const run = async (condition, timeoutMs) => {
    calls.length = 0;
    const result = await browser.waitFor({ condition, timeoutMs });
    assert.equal(result.url, "https://example.com/");
    return calls.slice(0, -2);
  };

  const element = await run({ kind: "element", target: "#ready", state: "visible" }, 1000);
  const text = await run({ kind: "text", text: "Complete", state: "hidden" }, 2000);
  const url = await run({ kind: "url", url: "**/dashboard" }, 3000);
  const load = await run({ kind: "load", state: "networkidle" }, 4000);
  const time = await run({ kind: "time", timeMs: 250 }, 5000);

  assert.deepEqual(
    [element, text, url, load, time].map((entry) => entry[0][0]),
    ["element", "text", "url", "load", "time"],
  );
  assert.equal(element[0][2].state, "visible");
  assert.deepEqual(text[0][3], { visible: true });
  assert.equal(text[0][4].state, "detached");
  assert.equal(url[0][1], "**/dashboard");
  assert.equal(load[0][1], "networkidle");
  assert.equal(time[0][1], 250);
});
