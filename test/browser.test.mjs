import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { assertUploadPath, ChromiumFishBrowser } from "../dist/browser.js";

const config = {
  headless: true,
  windowSize: [1280, 720],
  allowEval: false,
  allowNativeAgent: false,
  maxTextChars: 50_000,
  allowedHosts: [],
  uploadDirs: [],
};

/**
 * actionBaseline arms framenavigated/request listeners before every action. Fakes whose
 * pages never navigate accept and drop them.
 */
const NO_NAV = { on: () => undefined, off: () => undefined };

/** What resolveTarget's staleness evaluate returns for a live, non-file element. */
const LIVE = { connected: true, fileInput: false, multiple: false };

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
    ...NO_NAV,
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
    ...NO_NAV,
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
    ...NO_NAV,
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
    evaluate: async (callback) => String(callback).includes("isConnected") ? LIVE : ({
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
      if (source.includes("isConnected")) return LIVE;
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
    ...NO_NAV,
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
    evaluate: async () => LIVE,
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
    ...NO_NAV,
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
    ...NO_NAV,
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
    evaluate: async () => LIVE,
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
    ...NO_NAV,
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
    ...NO_NAV,
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
    evaluate: async (callback) => String(callback).includes("isConnected") ? LIVE : "radio",
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
    ...NO_NAV,
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

  await assert.rejects(browser.takeScreenshot({ fullPage: true }), /too large/);
  await assert.rejects(browser.takeScreenshot({ fullPage: false }), /too large/);
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
  await assert.rejects(browser.takeScreenshot({ fullPage: true }), /8000x8000/);
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
    ...NO_NAV,
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

async function uploadFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cf-upload-")));
  const inside = join(root, "inside.txt");
  await writeFile(inside, "abc");
  const outsideRoot = await realpath(await mkdtemp(join(tmpdir(), "cf-outside-")));
  const outside = join(outsideRoot, "secret.txt");
  await writeFile(outside, "secret");
  await mkdir(join(root, "sub"));
  return { root, inside, outside, outsideRoot };
}

test("assertUploadPath confines uploads to the configured roots", async () => {
  const { root, inside, outside } = await uploadFixture();

  // Returns the size too, so uploadFile does not stat the same file again.
  assert.deepEqual(await assertUploadPath(inside, [root]), { path: inside, bytes: 3 });
  // A relative path is resolved against the process, not silently rejected.
  assert.equal((await assertUploadPath(relative(process.cwd(), inside), [root])).path, inside);

  await assert.rejects(assertUploadPath(outside, [root]), /outside every --upload-dir root/);
  await assert.rejects(assertUploadPath(join(root, "nope.txt"), [root]), /does not exist/);
  await assert.rejects(assertUploadPath(join(root, "sub"), [root]), /not a regular file/);
  await assert.rejects(assertUploadPath(inside, []), /Uploads are disabled/);
});

test("assertUploadPath resolves symlinks before the containment check", async (t) => {
  const { root, outside } = await uploadFixture();
  const link = join(root, "link.txt");
  try {
    await symlink(outside, link);
  } catch {
    // Windows needs elevation or Developer Mode to create file symlinks.
    t.skip("symlink creation not permitted");
    return;
  }
  // The link sits inside the root; only realpath reveals that its target does not.
  await assert.rejects(assertUploadPath(link, [root]), /outside every --upload-dir root/);
});

test("assertUploadPath matches roots that are themselves symlinks", async (t) => {
  const { root, inside } = await uploadFixture();
  const aliasParent = await mkdtemp(join(tmpdir(), "cf-alias-"));
  const alias = join(aliasParent, "root");
  try {
    await symlink(root, alias, "dir");
  } catch {
    t.skip("symlink creation not permitted");
    return;
  }
  // Realpathing only the file would leave this failing to match its own root.
  assert.equal((await assertUploadPath(inside, [alias])).path, inside);
});

test("uploadFile rejects a non-file input before touching the page", async () => {
  const handle = {
    evaluate: async () => LIVE,
    setInputFiles: async () => assert.fail("must not attach to a non-file input"),
  };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ first: () => ({ elementHandle: async () => handle }) }),
  };
  const browser = new ChromiumFishBrowser({ ...config, uploadDirs: [tmpdir()] });
  browser.page = async () => ({ frames: () => [main], mainFrame: () => main });

  await assert.rejects(
    browser.uploadFile("#name", ["/tmp/a.txt"]),
    /is not a file input/,
  );
});

test("uploadFile validates every path before attaching any of them", async () => {
  const { root, inside, outside } = await uploadFixture();
  let attached;
  const handle = {
    evaluate: async () => ({ connected: true, fileInput: true, multiple: true }),
    setInputFiles: async (paths) => {
      attached = paths;
    },
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
    ...NO_NAV,
    url: () => "https://example.com/",
    title: async () => "Example",
    isClosed: () => false,
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
  };
  const browser = new ChromiumFishBrowser({ ...config, uploadDirs: [root] });
  browser.page = async () => page;

  // One bad entry must leave the input untouched rather than attaching a partial list.
  await assert.rejects(
    browser.uploadFile("input[type=file]", [inside, outside]),
    /outside every --upload-dir root/,
  );
  assert.equal(attached, undefined);

  const result = await browser.uploadFile("input[type=file]", [inside]);
  assert.deepEqual(attached, [inside]);
  // Base names only: the host's directory layout never reaches the caller.
  assert.deepEqual(result.files, [{ name: "inside.txt", bytes: 3 }]);
});

test("uploadFile rejects multiple files on a single-file input", async () => {
  const { root, inside } = await uploadFixture();
  const handle = {
    evaluate: async () => ({ connected: true, fileInput: true, multiple: false }),
    setInputFiles: async () => assert.fail("must not attach past the multiple check"),
  };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ first: () => ({ elementHandle: async () => handle }) }),
  };
  const browser = new ChromiumFishBrowser({ ...config, uploadDirs: [root] });
  browser.page = async () => ({ frames: () => [main], mainFrame: () => main });

  await assert.rejects(
    browser.uploadFile("input[type=file]", [inside, inside]),
    /not marked multiple/,
  );
});

test("click on a file input fails loudly instead of silently doing nothing", async () => {
  const handle = {
    evaluate: async () => ({ connected: true, fileInput: true, multiple: false }),
  };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ first: () => ({ elementHandle: async () => handle }) }),
  };
  const page = { frames: () => [main], mainFrame: () => main };

  // Without --upload-dir the tool is absent, so the error has to say why.
  const gated = new ChromiumFishBrowser(config);
  gated.page = async () => page;
  await assert.rejects(gated.click("input[type=file]"), /started without --upload-dir/);

  const enabled = new ChromiumFishBrowser({ ...config, uploadDirs: [tmpdir()] });
  enabled.page = async () => page;
  await assert.rejects(enabled.click("input[type=file]"), /Use upload_file instead/);

  // The guard is click-only: hover and the rest still resolve a file input normally.
  const hovered = new ChromiumFishBrowser(config);
  hovered.page = async () => page;
  await assert.rejects(
    hovered.hover("input[type=file]"),
    (error) => !/file input/.test(error.message),
  );
});

/** Page fake that records mouse traffic, for the drag tests. */
function draggablePage(handles, { viewport = { width: 1280, height: 720 } } = {}) {
  const events = [];
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: (selector) => ({
      first: () => ({ elementHandle: async () => handles[selector] }),
    }),
  };
  return {
    events,
    page: {
      frames: () => [main],
      mainFrame: () => main,
    ...NO_NAV,
      url: () => "https://example.com/",
      title: async () => "Example",
      isClosed: () => false,
      viewportSize: () => viewport,
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      mouse: {
        move: async (x, y) => events.push(["move", x, y]),
        down: async () => events.push(["down"]),
        up: async () => events.push(["up"]),
      },
    },
  };
}

function draggableHandle(box) {
  return {
    evaluate: async () => LIVE,
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => box,
  };
}

test("drag presses, follows a curved path, and releases in order", async () => {
  const handles = { "#slider": draggableHandle({ x: 100, y: 300, width: 40, height: 40 }) };
  const { events, page } = draggablePage(handles);
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const result = await browser.drag("#slider", { dx: 260, dy: 0 });

  const down = events.findIndex((event) => event[0] === "down");
  const up = events.findIndex((event) => event[0] === "up");
  assert.ok(down > 0, "moves to the source before pressing");
  assert.ok(up > down);
  // The path between press and release is what a trajectory check scores; a straight
  // two-point interpolation would defeat the point of routing through moveMouse.
  const dragMoves = events.slice(down, up).filter((event) => event[0] === "move");
  assert.ok(dragMoves.length >= 14, `expected a stepped path, got ${dragMoves.length} moves`);
  const offAxis = dragMoves.some((event) => Math.abs(event[2] - result.from.y) > 0.5);
  assert.ok(offAxis, "path should bow off the straight line");

  assert.equal(Math.round(result.to.x - result.from.x), 260);
  assert.equal(Math.round(result.to.y - result.from.y), 0);
  const [, lastX, lastY] = dragMoves.at(-1);
  assert.ok(Math.abs(lastX - result.to.x) < 0.001);
  assert.ok(Math.abs(lastY - result.to.y) < 0.001);
});

test("drag onto a target element measures the destination without scrolling it", async () => {
  let destScrolled = false;
  const handles = {
    "#card": draggableHandle({ x: 100, y: 100, width: 50, height: 50 }),
    "#column": {
      evaluate: async () => LIVE,
      scrollIntoViewIfNeeded: async () => {
        destScrolled = true;
      },
      boundingBox: async () => ({ x: 600, y: 400, width: 200, height: 200 }),
    },
  };
  const { page } = draggablePage(handles);
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const result = await browser.drag("#card", { toTarget: "#column" });
  // Scrolling the destination mid-drag would slide the source out from under the cursor.
  assert.equal(destScrolled, false);
  assert.ok(result.to.x >= 670 && result.to.x <= 730);
  assert.ok(result.to.y >= 470 && result.to.y <= 530);
});

test("drag rejects an ambiguous or out-of-viewport destination", async () => {
  const handles = { "#slider": draggableHandle({ x: 100, y: 300, width: 40, height: 40 }) };
  const { page } = draggablePage(handles);
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await assert.rejects(browser.drag("#slider", {}), /exactly one destination/);
  await assert.rejects(
    browser.drag("#slider", { toTarget: "#column", dx: 10 }),
    /exactly one destination/,
  );
  await assert.rejects(browser.drag("#slider", { dx: 5000, dy: 0 }), /outside the 1280x720/);
});

/**
 * Page fake that owns a scroll offset and routes evaluate by what the callback reads, so a
 * capture can be observed to move the page and then put it back.
 *
 * No handle here exposes scrollIntoViewIfNeeded: element capture must not call it, and the
 * missing method turns a regression into a failure instead of a silently passing test.
 */
function screenshotPage(handles, { scale = 1 } = {}) {
  const scroll = { x: 0, y: 0 };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: (selector) => ({ first: () => ({ elementHandle: async () => handles[selector] }) }),
  };
  return {
    scroll,
    page: {
      frames: () => [main],
      mainFrame: () => main,
    ...NO_NAV,
      viewportSize: () => ({ width: 1280, height: 720 }),
      screenshot: async () => assert.fail("must not fall back to a page capture"),
      evaluate: async (callback, arg) => {
        const source = String(callback);
        if (source.includes("devicePixelRatio")) return scale;
        if (source.includes("scrollX")) return [scroll.x, scroll.y];
        if (source.includes("scrollTo")) {
          [scroll.x, scroll.y] = arg;
          return undefined;
        }
        return assert.fail(`unexpected page.evaluate: ${source}`);
      },
    },
  };
}

test("element screenshot crops, and puts back the scroll the capture moved", async () => {
  let captured;
  const handles = {
    "#badge": {
      evaluate: async () => LIVE,
      boundingBox: async () => ({ x: 10, y: 20, width: 120, height: 40 }),
      screenshot: async (options) => {
        captured = options;
        // Playwright scrolls the element into view itself and does not restore afterwards.
        fake.scroll.y = 2475;
        return Buffer.from("element-png");
      },
    },
  };
  const fake = screenshotPage(handles);
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;

  const png = await browser.takeScreenshot({ target: "#badge" });
  assert.equal(png.toString(), "element-png");
  assert.deepEqual(captured, { type: "png" });
  // take_screenshot is annotated readOnlyHint, and viewport coordinates the caller already
  // holds would silently address the wrong pixels if the page stayed where the capture left it.
  assert.deepEqual(fake.scroll, { x: 0, y: 0 });

  await assert.rejects(
    browser.takeScreenshot({ target: "#badge", fullPage: true }),
    /cannot combine target with fullPage/,
  );
});

test("element screenshot restores the scroll even when the capture fails", async () => {
  const handles = {
    "#badge": {
      evaluate: async () => LIVE,
      boundingBox: async () => ({ x: 10, y: 20, width: 120, height: 40 }),
      screenshot: async () => {
        fake.scroll.y = 900;
        throw new Error("Target closed");
      },
    },
  };
  const fake = screenshotPage(handles);
  fake.scroll.y = 120;
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;

  await assert.rejects(browser.takeScreenshot({ target: "#badge" }), /Target closed/);
  assert.deepEqual(fake.scroll, { x: 0, y: 120 });
});

test("element screenshot rejects an invisible element and honors the pixel budget", async () => {
  const boxes = { "#hidden": null, "#huge": { x: 0, y: 0, width: 9_000, height: 9_000 } };
  const handles = Object.fromEntries(Object.entries(boxes).map(([selector, box]) => [selector, {
    evaluate: async () => LIVE,
    boundingBox: async () => box,
    screenshot: async () => assert.fail("must not capture past the budget check"),
  }]));
  // Scale 2 turns a 9000px box into 18000px of PNG.
  const fake = screenshotPage(handles, { scale: 2 });
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;

  // A display:none target reports a null box straight away. Scrolling first would instead
  // spend the whole locator timeout inside Playwright before failing with its own error.
  await assert.rejects(browser.takeScreenshot({ target: "#hidden" }), /no visible box/);
  await assert.rejects(browser.takeScreenshot({ target: "#huge" }), /18000x18000/);
  assert.deepEqual(fake.scroll, { x: 0, y: 0 });
});

/**
 * Page fake that models a navigation the way Chromium sequences one: the request goes out
 * immediately, the old document stays current and already loaded, and the commit lands
 * later. waitForLoadState therefore answers about the outgoing document, which is exactly
 * what made actionResult describe the wrong page.
 */
function navigatingPage({ commitAfterMs = 40, from = "https://example.com/login", to = "https://example.com/clientarea" } = {}) {
  const listeners = { request: [], framenavigated: [] };
  const main = {
    url: () => state.url,
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ first: () => ({ elementHandle: async () => handle }) }),
  };
  const handle = {
    evaluate: async () => LIVE,
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 10, y: 10, width: 40, height: 20 }),
  };
  const state = { url: from, committed: false, titleReads: [] };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    isClosed: () => false,
    url: () => state.url,
    // Chromium's placeholder while the destination has not arrived.
    title: async () => (state.committed ? "Client Area" : `Loading ${to}`),
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: { move: async () => undefined, down: async () => undefined, up: async () => undefined },
    on: (event, fn) => listeners[event]?.push(fn),
    off: (event, fn) => {
      const list = listeners[event] ?? [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // Resolves at once: the current document is the old one, and it finished loading long ago.
    waitForLoadState: async () => undefined,
  };
  return {
    page,
    listeners,
    state,
    /** Drive the navigation the way the browser would once the click lands. */
    start() {
      for (const fn of listeners.request) {
        fn({ isNavigationRequest: () => true, frame: () => main });
      }
      if (commitAfterMs !== null) {
        setTimeout(() => {
          state.url = to;
          state.committed = true;
          for (const fn of [...listeners.framenavigated]) fn(main);
        }, commitAfterMs);
      }
    },
  };
}

test("an action waits for the navigation it started instead of describing the outgoing page", async () => {
  const fake = navigatingPage({ commitAfterMs: 400 });
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;
  // The click issues the navigation request; the commit lands well after the settle window.
  fake.page.mouse.down = async () => {
    fake.start();
  };

  const result = await browser.click("#login");

  assert.equal(result.url, "https://example.com/clientarea");
  assert.equal(result.navigated, true);
  assert.equal(result.title, "Client Area");
  assert.equal(result.navigationPending, undefined);
  // Both listeners come off, or every action leaks one onto the page.
  assert.equal(fake.listeners.request.length, 0);
  assert.equal(fake.listeners.framenavigated.length, 0);
});

test("a navigation that outlasts the bound is reported, not silently read as a no-op", async () => {
  const fake = navigatingPage({ commitAfterMs: null });
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;
  fake.page.mouse.down = async () => {
    fake.start();
  };
  // Keep the test quick: the real bound is ACTION_NAV_COMMIT_TIMEOUT_MS.
  fake.page.waitForTimeout = async (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60)));

  const result = await browser.click("#login");

  assert.equal(result.ok, true);
  assert.equal(result.navigationPending, true);
  assert.equal(result.navigated, false);
  assert.equal(result.url, "https://example.com/login");
  // Chromium's "Loading <url>" placeholder is not a title and must not be passed off as one.
  assert.equal(result.title, "");
  assert.equal(fake.listeners.request.length, 0);
});

test("an action that navigates nothing does not pay the navigation wait", async () => {
  const fake = navigatingPage();
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;
  const waits = [];
  fake.page.waitForTimeout = async (ms) => {
    waits.push(ms);
  };

  const result = await browser.click("#noop");

  assert.equal(result.navigated, false);
  assert.equal(result.navigationPending, undefined);
  // The settle window and the click's own dwell, and nothing else: with no navigation
  // request seen there is nothing to wait for, so the commit bound is never armed. Asserting
  // on that bound rather than a total keeps the click's randomized dwell out of the fixture.
  assert.ok(waits.includes(150), `expected the settle window, got ${waits.join()}`);
  assert.ok(
    waits.every((ms) => ms < 1_000),
    `no wait should approach the commit bound, got ${waits.join()}`,
  );
});

test("snapshot and get_text retry a read the committing navigation destroyed", async () => {
  let attempts = 0;
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({
      elementHandles: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("locator.elementHandles: Execution context was destroyed, most likely because of a navigation");
        }
        return [];
      },
      first: () => ({
        innerText: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("Execution context was destroyed, most likely because of a navigation");
          return "Account: Rebecka";
        },
      }),
    }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    ...NO_NAV,
    waitForLoadState: async () => undefined,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  assert.equal(await browser.snapshot(), "(No visible interactive elements)");
  assert.equal(attempts, 2);

  attempts = 0;
  assert.equal(await browser.getText({ selector: "body" }), "Account: Rebecka");
  assert.equal(attempts, 2);
});

test("a read failure that is not a navigation race still surfaces", async () => {
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({
      elementHandles: async () => {
        throw new Error("Unknown engine \"nope\" while parsing selector");
      },
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
    ...NO_NAV,
    waitForLoadState: async () => assert.fail("must not settle for a non-navigation error"),
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await assert.rejects(browser.snapshot(), /Unknown engine/);
  await assert.rejects(browser.getText({ selector: "[broken" }), /Invalid selector/);
});

test("navigation listeners come off the page whether the action succeeds or throws", async (t) => {
  const counts = { request: 0, framenavigated: 0 };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ first: () => ({ elementHandle: async () => handle }) }),
  };
  const handle = { evaluate: async () => LIVE };
  let pressFails = false;
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    isClosed: () => false,
    url: () => "https://example.com/",
    title: async () => "Example",
    on: (event) => { counts[event] += 1; },
    off: (event) => { counts[event] -= 1; },
    keyboard: {
      press: async () => {
        if (pressFails) throw new Error("Keyboard press failed");
      },
    },
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  await browser.pressKey("Enter");
  assert.deepEqual(counts, { request: 0, framenavigated: 0 }, "released as soon as the result is built");

  // An action that throws never reaches actionResult, so release() never runs for it. The
  // listeners still have to go: without a bound, a session of failing actions accumulates a
  // pair per attempt on the page and eventually trips Node's max-listeners warning.
  pressFails = true;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(browser.pressKey("Enter"), /Keyboard press failed/);
  }
  assert.equal(counts.request, 5, "still attached while the commit window is open");
  t.mock.timers.tick(20_000);
  assert.deepEqual(counts, { request: 0, framenavigated: 0 }, "detached once the window closes");
});

/**
 * Drive solveChallenge against a scripted sequence of observations. The real method reads
 * the page through observeChallenge only, so stubbing that is enough to exercise every
 * reporting path without a browser.
 */
function challengeBrowser(states) {
  const browser = new ChromiumFishBrowser(config);
  const page = {
    url: () => "https://site.example/gate",
    title: async () => "Just a moment...",
    viewportSize: () => ({ width: 1280, height: 720 }),
    frames: () => [],
    waitForTimeout: async () => undefined,
    mouse: { move: async () => undefined, down: async () => undefined, up: async () => undefined },
    ...NO_NAV,
  };
  browser.page = async () => page;
  let round = 0;
  browser.observeChallenge = async () => {
    const present = states[Math.min(round++, states.length - 1)];
    return {
      detection: {
        present,
        kind: present ? "interstitial" : "none",
        title: present ? "Just a moment..." : "Dashboard",
        url: "https://site.example/gate",
        bodySnippet: "",
        widget: { x: 100, y: 100, width: 300, height: 65 },
        widgetState: present ? "verifying" : "absent",
        tokenPresent: !present,
        frames: [],
      },
      kind: present ? "interstitial" : "none",
      widgetState: present ? "verifying" : "success",
      tokenPresent: !present,
      hasChallengeFrame: present,
      bodyText: present ? "Verifying you are human. This may take a few seconds." : "Welcome back",
    };
  };
  browser.ensureWidgetInViewport = async (_page, widget) => widget;
  browser.findTurnstileWidget = async () => ({ x: 100, y: 100, width: 300, height: 65 });
  return browser;
}

test("an unchallenged page reports that nothing was found, done, or verified", async () => {
  const browser = challengeBrowser([false]);

  const result = await browser.solveChallenge({ timeoutMs: 3_000, maxClicks: 2 });

  assert.equal(result.ok, true, "ok stays true: the page is not blocked and work can continue");
  // ok alone reads as "the captcha was defeated" on a tool called solve_challenge. These are
  // the fields that make the difference reportable.
  assert.equal(result.challengeObserved, false);
  assert.equal(result.interactionPerformed, false);
  assert.equal(result.clearanceVerified, false);
  assert.equal(result.method, "already_clear");
  assert.deepEqual(result.clicks, []);
});

test("a challenge that clears itself is not reported as a click", async () => {
  // Present and verifying on entry, then through on its own: a managed interstitial
  // finishing its automatic check while solve_challenge is running.
  const browser = challengeBrowser([true, true, false]);

  const result = await browser.solveChallenge({ timeoutMs: 20_000, maxClicks: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.method, "self_cleared", "method must follow what was done, not how it ended");
  assert.equal(result.challengeObserved, true);
  assert.equal(result.interactionPerformed, false);
  assert.equal(result.clearanceVerified, true, "clearance was positively confirmed, just not by us");
  assert.equal(result.attempts, 0);
});

test("interactionPerformed cannot disagree with the clicks it reports", async () => {
  // Never clears, so the run exhausts its clicks and times out.
  const browser = challengeBrowser([true]);

  const result = await browser.solveChallenge({ timeoutMs: 4_000, maxClicks: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.clearanceVerified, false, "a timeout verifies nothing");
  assert.equal(result.challengeObserved, true);
  // Derived in finish() from clicks, so no return site can assert an interaction it did
  // not perform — which is how method "click" came to be reported after zero clicks.
  assert.equal(result.interactionPerformed, result.clicks.length > 0);
});

test("a concurrent call claims neither observation nor interaction", async () => {
  const browser = challengeBrowser([true]);
  browser.solveChallengeInFlight = true;
  browser.readBody = async () => "Just a moment...";

  const result = await browser.solveChallenge({});

  assert.equal(result.ok, false);
  assert.equal(result.method, "busy");
  // It returned before looking at anything; reporting otherwise would invent a finding.
  assert.equal(result.challengeObserved, false);
  assert.equal(result.interactionPerformed, false);
  assert.equal(result.clearanceVerified, false);
});

test("a challenge that vanishes before its widget mounts is not reported as verified", async () => {
  // Present, but the widget never appears; then the challenge is simply gone. Nothing was
  // confirmed — it stopped being visible, which is not the same thing.
  const browser = challengeBrowser([true, true, false]);
  const observe = browser.observeChallenge;
  browser.observeChallenge = async () => {
    const result = await observe();
    return { ...result, detection: { ...result.detection, widget: undefined } };
  };

  const result = await browser.solveChallenge({ timeoutMs: 6_000, maxClicks: 2 });

  assert.equal(result.ok, true, "not blocked, so work can continue");
  assert.equal(result.method, "already_clear");
  assert.equal(result.challengeObserved, true, "a challenge really was there");
  assert.equal(result.interactionPerformed, false);
  assert.equal(result.clearanceVerified, false, "it disappeared; that is not confirmation");
});
