import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { assertUploadPath, ChromiumFishBrowser, safeDownloadName } from "../dist/browser.js";

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

test("concurrent callers join the browser start already running", async () => {
  // MCP dispatches tool calls concurrently, so two of them routinely arrive while the
  // browser is still launching. Each starting its own leaves the loser's browser running
  // for the life of the process: close() only ever knew about the last one assigned.
  let starts = 0;
  const context = { pages: () => [] };
  const browser = new ChromiumFishBrowser(config);
  browser.startContext = async () => {
    starts += 1;
    await new Promise((resolve) => setImmediate(resolve));
    browser.browser = { isConnected: () => true };
    browser.context = context;
    return context;
  };

  const [first, second] = await Promise.all([browser.ensureContext(), browser.ensureContext()]);
  assert.equal(starts, 1);
  assert.equal(first, context);
  assert.equal(second, context);

  // A failed start must not be cached, or one bad launch would poison every later call.
  const failing = new ChromiumFishBrowser(config);
  let attempts = 0;
  failing.startContext = async () => {
    attempts += 1;
    throw new Error("browser executable is missing");
  };
  await assert.rejects(failing.ensureContext(), /executable is missing/);
  await assert.rejects(failing.ensureContext(), /executable is missing/);
  assert.equal(attempts, 2);
});

test("concurrent callers do not each open a tab", async () => {
  // A freshly created context has no pages, so both callers would find nothing to reuse.
  let opened = 0;
  const browser = new ChromiumFishBrowser(config);
  browser.browser = { isConnected: () => true };
  browser.context = {
    pages: () => [],
    newPage: async () => {
      opened += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { isClosed: () => false, once: () => undefined };
    },
  };

  const [first, second] = await Promise.all([browser.page(), browser.page()]);
  assert.equal(opened, 1);
  assert.equal(first, second);
});

test("close waits for a launch already in flight instead of leaking it", async () => {
  // The shutdown edge of the race above. close() used to null the fields and return while
  // a launch was still running; that launch then assigned this.browser on its way out, and
  // nothing ever closed it. SIGINT during the first tool call is the way to hit it.
  let closedBrowser = false;
  let closedContext = false;
  const browser = new ChromiumFishBrowser(config);
  const context = { pages: () => [], close: async () => { closedContext = true; } };
  browser.startContext = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    browser.browser = { isConnected: () => true, close: async () => { closedBrowser = true; } };
    browser.context = context;
    return context;
  };

  const launching = browser.ensureContext();
  await browser.close();

  assert.equal(closedBrowser, true, "the in-flight launch's browser must be closed");
  assert.equal(closedContext, true);
  assert.equal(browser.browser, undefined);
  assert.equal(browser.context, undefined);
  await launching;

  // And nothing starts a replacement afterwards: the shutdown is not a restart trigger.
  await assert.rejects(browser.ensureContext(), /shutting down/);
});

test("tracking a page again does not stack close listeners", async () => {
  // page() re-tracks a tab it falls back to after the current one closed, and every extra
  // registration is one more listener on the same event.
  let listeners = 0;
  const page = { once: () => { listeners += 1; }, isClosed: () => false };
  const browser = new ChromiumFishBrowser(config);
  browser.trackPage(page);
  browser.trackPage(page);
  assert.equal(listeners, 1);
});

test("--chrome-path rejects the options only the upstream launcher can honor", async () => {
  // Both would otherwise be dropped on the floor: the local executable is the build that
  // runs, and it cannot resolve "auto" either. process.execPath just has to exist.
  const local = { ...config, chromePath: process.execPath };
  await assert.rejects(
    new ChromiumFishBrowser({ ...local, timezone: "auto" }).ensureContext(),
    /--timezone auto/,
  );
  await assert.rejects(
    new ChromiumFishBrowser({ ...local, browserVersion: "1.2.3" }).ensureContext(),
    /--browser-version/,
  );
});

/** Register the dialog handler against a fake context and hand back the way to fire it. */
function dialogHandler(browser) {
  let fire;
  browser.installDialogHandler({
    on: (event, listener) => {
      if (event === "dialog") fire = listener;
    },
  });
  return fire;
}

function fakeDialog(page, { type = "confirm", message = "Delete everything?" } = {}) {
  const answers = [];
  return {
    answers,
    type: () => type,
    message: () => message,
    page: () => page,
    accept: async (text) => { answers.push(["accept", text]); },
    dismiss: async () => { answers.push(["dismiss"]); },
  };
}

test("an unarmed dialog is dismissed, and the action that raised it says so", async () => {
  // Playwright dismisses dialogs only while nothing listens; the answer is the same as
  // before, but a click that merely raised confirm("Delete?") no longer reads as a click
  // that deleted something.
  const page = {};
  const browser = new ChromiumFishBrowser(config);
  const fire = dialogHandler(browser);
  const { sink } = browser.openSideEffectSink(page);

  const dialog = fakeDialog(page);
  fire(dialog);
  assert.deepEqual(dialog.answers, [["dismiss"]]);
  assert.deepEqual(sink.dialogs, [{
    type: "confirm",
    message: "Delete everything?",
    accepted: false,
  }]);

  const result = { ok: true, url: "", title: "", navigated: false };
  browser.applySideEffects(result, sink);
  assert.equal(result.dialogs.length, 1);
  assert.equal(result.dialogsOmitted, undefined);
});

test("handle_dialog arms one answer, and beforeunload defaults to accept", async () => {
  const page = {};
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;
  const fire = dialogHandler(browser);

  assert.deepEqual(await browser.handleDialog(true, "Rebecka"), {
    pageId: "page-1",
    accept: true,
    promptText: "Rebecka",
  });
  const prompt = fakeDialog(page, { type: "prompt", message: "Your name?" });
  fire(prompt);
  assert.deepEqual(prompt.answers, [["accept", "Rebecka"]]);

  // Armed once, consumed once: the next dialog is back to the dismiss default, or a single
  // handle_dialog would silently authorize every confirm that follows it.
  const second = fakeDialog(page);
  fire(second);
  assert.deepEqual(second.answers, [["dismiss"]]);

  // Dismissing beforeunload would cancel the navigation the caller just asked for.
  const leaving = fakeDialog(page, { type: "beforeunload", message: "" });
  fire(leaving);
  assert.deepEqual(leaving.answers, [["accept", undefined]]);
});

test("a dialog is answered even when reading it fails", async () => {
  // The one outcome that cannot be allowed: Playwright freezes the page until a listener
  // answers, so an exception on the way to the answer would hang every later tool call.
  const page = {};
  const browser = new ChromiumFishBrowser(config);
  const fire = dialogHandler(browser);
  const answers = [];
  fire({
    type: () => { throw new Error("dialog went away"); },
    message: () => "",
    page: () => page,
    accept: async () => { answers.push("accept"); },
    dismiss: async () => { answers.push("dismiss"); },
  });
  assert.deepEqual(answers, ["dismiss"]);
});

test("only the reported dialogs are listed, and the rest are counted", async () => {
  const page = {};
  const browser = new ChromiumFishBrowser(config);
  const fire = dialogHandler(browser);
  const { sink } = browser.openSideEffectSink(page);
  for (let index = 0; index < 8; index += 1) fire(fakeDialog(page, { type: "alert" }));

  const result = { ok: true, url: "", title: "", navigated: false };
  browser.applySideEffects(result, sink);
  assert.equal(result.dialogs.length, 5);
  assert.equal(result.dialogsOmitted, 3);
});

test("a closed side-effect window collects nothing further", async () => {
  const page = {};
  const browser = new ChromiumFishBrowser(config);
  const fire = dialogHandler(browser);
  const { sink, close } = browser.openSideEffectSink(page);
  close();
  fire(fakeDialog(page));
  assert.deepEqual(sink.dialogs, []);
});

test("safeDownloadName reduces a server-chosen name to something writable", () => {
  // What Chromium actually hands over for a server sending "../../../evil:name.pdf",
  // measured against Chrome: it normalizes first, and this is already safe to write.
  assert.equal(safeDownloadName("_.._.._evil_name.pdf"), "_.._.._evil_name.pdf");
  // The rest is the case Chromium's normalization is not promised to cover. Playwright
  // only documents the name as "typically computed by the browser".
  assert.equal(safeDownloadName("../../../.ssh/authorized_keys"), "authorized_keys");
  assert.equal(safeDownloadName("..\\..\\Windows\\System32\\drivers\\etc\\hosts"), "hosts");
  assert.equal(safeDownloadName("report.pdf"), "report.pdf");
  assert.equal(safeDownloadName(".."), "download");
  assert.equal(safeDownloadName(""), "download");
  assert.equal(safeDownloadName("   "), "download");
  assert.equal(safeDownloadName(".bashrc"), "bashrc");
  // Still the console device on Windows, extension or not.
  assert.equal(safeDownloadName("CON.txt"), "download-CON.txt");
  assert.equal(safeDownloadName("in:va|lid?.txt"), "invalid.txt");
  assert.equal(safeDownloadName("trailing.  "), "trailing");
  assert.ok(safeDownloadName("x".repeat(400)).length <= 100);
});

test("a download lands in the configured root, and a repeat does not overwrite it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cfmcp-dl-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const browser = new ChromiumFishBrowser({ ...config, downloadDir: root });

  const download = (name) => ({
    url: () => `https://example.com/${name}`,
    suggestedFilename: () => name,
    createReadStream: async () => Readable.from(["report"]),
    delete: async () => undefined,
  });

  const first = { url: "", suggestedFilename: "../../report.pdf", state: "pending" };
  await browser.saveDownload(download("../../report.pdf"), first);
  assert.equal(first.state, "saved");
  assert.equal(first.file, "report.pdf");
  assert.equal(first.bytes, 6);
  assert.equal(await readFile(join(root, "report.pdf"), "utf8"), "report");

  const second = { url: "", suggestedFilename: "report.pdf", state: "pending" };
  await browser.saveDownload(download("report.pdf"), second);
  assert.equal(second.file, "report (2).pdf");
});

test("without --download-dir a download is discarded and reported as such", async () => {
  const page = {};
  const browser = new ChromiumFishBrowser(config);
  let fire;
  browser.installDownloadHandler({
    on: (event, listener) => {
      if (event === "download") fire = listener;
    },
  });
  const { sink } = browser.openSideEffectSink(page);
  let deleted = false;
  fire({
    url: () => "https://example.com/invoice.pdf",
    suggestedFilename: () => "invoice.pdf",
    page: () => page,
    delete: async () => { deleted = true; },
    saveAs: async () => assert.fail("nothing may be written without a root"),
  });

  assert.equal(sink.downloads.length, 1);
  assert.equal(sink.downloads[0].state, "discarded");
  assert.match(sink.downloads[0].error, /--download-dir/);
  // The click did something; a caller that only saw ok: true would conclude it did not.
  assert.deepEqual(await browser.listDownloads(), sink.downloads);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleted, true);
});

test("navigation guard blocks disallowed top-level requests only", async () => {
  const browser = new ChromiumFishBrowser({ ...config, allowedHosts: ["example.com"] });
  let handler;
  await browser.installNavigationGuard({
    on: () => undefined,
    route: async (pattern, callback) => {
      assert.equal(pattern, "**/*");
      handler = callback;
    },
  });

  function mockRoute(url, { navigation = true, topLevel = true, frameError = false } = {}) {
    const actions = [];
    const page = {};
    browser.redirectGuards.set(page, Promise.resolve());
    return {
      actions,
      request: () => ({
        isNavigationRequest: () => navigation,
        url: () => url,
        frame: () => {
          if (frameError) throw new Error("Frame unavailable");
          return { parentFrame: () => topLevel ? null : {}, page: () => page };
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
    click: async () => { checked = true; },
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
    click: async () => page.mouse.up(),
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

test("a single line wider than maxChars still reports its element", async () => {
  // A <select multiple> with 20 long options and 20 selected values overruns a 5000-char
  // budget on its own. The line has to be cut to fit the truncation marker alongside it:
  // reserving nothing for the marker made the budget loop drop the only line there was,
  // returning a bare marker that claimed an element the caller could not see or use.
  const options = Array.from({ length: 20 }, (_, index) => ({
    value: `option-value-${index}-`.padEnd(120, "x"),
    label: `Option label ${index} `.padEnd(80, "y"),
  }));
  const disposed = [];
  const wide = {
    isVisible: async () => true,
    dispose: async () => disposed.push("wide"),
    evaluate: async () => ({
      tag: "select",
      explicitRole: "",
      hasList: false,
      multiple: true,
      size: 4,
      label: "Choose warehouses",
      href: "",
      disabled: false,
      type: "",
      value: null,
      passwordSet: false,
      checked: null,
      selected: options.map((option) => option.value),
      selectedCount: 20,
      options,
      optionCount: 20,
      expanded: null,
    }),
  };
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({ elementHandles: async () => [wide] }),
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => ({ frames: () => [main], mainFrame: () => main, ...NO_NAV });

  const result = await browser.snapshot({ maxChars: 5000 });
  assert.ok(result.length <= 5000, `output was ${result.length} chars`);
  assert.match(result, /^\[e1\] listbox "Choose warehouses"/);
  assert.match(result, / \[line truncated\]$/m);
  assert.match(result, /Snapshot truncated after 1 elements/);
  // The reference is usable precisely because it was printed; the handle stays alive for it.
  assert.deepEqual(disposed, []);
});

test("type_text checks the target before clearing, typing, and submitting", async () => {
  const events = [];
  const handle = {
    evaluate: async () => LIVE,
    scrollIntoViewIfNeeded: async () => undefined,
    boundingBox: async () => ({ x: 100, y: 200, width: 240, height: 32 }),
    click: async (options) => {
      assert.ok(options.delay >= 45 && options.delay <= 115);
      assert.ok(options.timeout > 0);
      assert.equal(options.force, undefined);
      assert.equal(options.noWaitAfter, true);
      events.push("checked-click");
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
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: {
      move: async () => events.push("move"),
      down: async () => events.push("down"),
      up: async () => events.push("up"),
      // The old path called mouse.click, which presses and releases with no gap.
      click: async () => events.push("click"),
    },
    keyboard: {
      press: async (key) => events.push(`press:${key}`),
      type: async (value, options) => events.push(`type:${value}:${options?.delay}`),
    },
    waitForTimeout: async () => events.push("wait"),
    waitForLoadState: async () => undefined,
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const result = await browser.typeText("#email", "user@example.com", true, true);
  assert.equal(result.ok, true);
  assert.equal(result.navigated, false);

  assert.ok(!events.includes("click"), "type_text must not emit a gapless mouse.click");
  const click = events.indexOf("checked-click");
  assert.ok(click > 0 && events[click - 1] === "move");
  const afterClick = events.slice(click + 1);
  assert.deepEqual(afterClick.slice(0, 2), [
    `press:${process.platform === "darwin" ? "Meta+A" : "Control+A"}`,
    "press:Backspace",
  ]);
  assert.equal(afterClick[2], "type:user@example.com:45");
  assert.equal(afterClick[3], "press:Enter");
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
    // goForward answers null when there is nothing ahead in history, exactly as a
    // same-document hash change does, so status is genuinely absent rather than zero.
    goForward: async (options) => {
      calls.push(["goForward", options]);
      return null;
    },
    reload: async (options) => {
      calls.push(["reload", options]);
      return { status: () => 503 };
    },
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
  // A 503 loads like any other document; without the status it reads as a good page.
  assert.deepEqual(await browser.reload(), {
    ok: true,
    title: "Example",
    url: "https://example.com/next",
    navigated: true,
    status: 503,
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

test("drag presses, follows a curved path, and releases in order", async (t) => {
  // moveMouse offsets its control point by (Math.random() - 0.5) * 80, so an axis-aligned
  // drag whose draw lands near 0.5 bows by less than the half pixel asserted below and the
  // path reads as straight. Pin the draw: the assertion is about the curve moveMouse builds
  // from a given offset, not about how often the offset happens to be large enough.
  t.mock.method(Math, "random", () => 0.9);
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
/**
 * Element handle for the screenshot tests, modelling one scrollable ancestor. Playwright's
 * own scrollIntoView moves containers as well as the window, so the restore has to be
 * observable on both.
 *
 * The window this handle reports is its own frame's, deliberately not the page fake's: an
 * element in a child frame has two windows to put back, and a restore that covers only one
 * of them has to fail a test rather than pass because both happened to read the same.
 */
function screenshotHandle({ box, container, screenshot }) {
  const frameWindow = { x: 0, y: 0 };
  return {
    boundingBox: async () => box,
    screenshot,
    evaluate: async (callback, arg) => {
      const source = String(callback);
      if (source.includes("isConnected")) return LIVE;
      // Capture reads scrollX; restore writes through scrollTo. Same split as the page fake.
      if (source.includes("scrollX")) {
        return { chain: [[0, 0], [container.x, container.y]], window: [frameWindow.x, frameWindow.y] };
      }
      if (source.includes("scrollTo")) {
        const [, ancestor] = arg.chain;
        [container.x, container.y] = ancestor;
        [frameWindow.x, frameWindow.y] = arg.window;
        return undefined;
      }
      return assert.fail(`unexpected handle.evaluate: ${source}`);
    },
  };
}

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
  const container = { x: 0, y: 0 };
  const handles = {
    "#badge": screenshotHandle({
      box: { x: 10, y: 20, width: 120, height: 40 },
      container,
      screenshot: async (options) => {
        captured = options;
        // Playwright scrolls the element into view itself and does not restore afterwards —
        // and it scrolls the containing overflow box, not only the window.
        fake.scroll.y = 2475;
        container.y = 640;
        return Buffer.from("element-png");
      },
    }),
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
  // A target inside an overflow container is displaced by the container's scroll, which the
  // window offset says nothing about.
  assert.deepEqual(container, { x: 0, y: 0 });

  await assert.rejects(
    browser.takeScreenshot({ target: "#badge", fullPage: true }),
    /cannot combine target with fullPage/,
  );
});

test("element screenshot restores the scroll even when the capture fails", async () => {
  const container = { x: 0, y: 0 };
  const handles = {
    "#badge": screenshotHandle({
      box: { x: 10, y: 20, width: 120, height: 40 },
      container,
      screenshot: async () => {
        fake.scroll.y = 900;
        container.y = 300;
        throw new Error("Target closed");
      },
    }),
  };
  const fake = screenshotPage(handles);
  fake.scroll.y = 120;
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;

  await assert.rejects(browser.takeScreenshot({ target: "#badge" }), /Target closed/);
  assert.deepEqual(fake.scroll, { x: 0, y: 120 });
  assert.deepEqual(container, { x: 0, y: 0 });
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
  const listeners = { request: [], framenavigated: [], requestfailed: [] };
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
  handle.click = async () => {
    await page.mouse.down();
    await page.mouse.up();
  };
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
  let navigationRequest;
  return {
    page,
    listeners,
    state,
    /** Drive the navigation the way the browser would once the click lands. */
    start() {
      navigationRequest = {
        isNavigationRequest: () => true,
        frame: () => main,
        url: () => to,
        failure: () => ({ errorText: "net::ERR_FAILED" }),
      };
      for (const fn of listeners.request) fn(navigationRequest);
      if (commitAfterMs !== null) {
        setTimeout(() => {
          state.url = to;
          state.committed = true;
          for (const fn of [...listeners.framenavigated]) fn(main);
        }, commitAfterMs);
      }
    },
    /** Cancel it the way a blocked route or a download conversion would. */
    fail(errorText = "net::ERR_BLOCKED_BY_CLIENT") {
      navigationRequest.failure = () => ({ errorText });
      for (const fn of [...listeners.requestfailed]) fn(navigationRequest);
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

test("a cancelled navigation is reported as cancelled, not left pending", async () => {
  // Never commits, exactly like the slow case above — the difference is only that the
  // request dies, which is what --allowed-host does to every blocked link.
  const fake = navigatingPage({ commitAfterMs: null });
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;
  fake.page.mouse.down = async () => {
    fake.start();
    // Lands inside actionResult's commit race rather than before it, so this also proves
    // the race returns on the failure instead of running out the ten-second bound.
    setTimeout(() => fake.fail(), 200);
  };

  const started = Date.now();
  const result = await browser.click("#external-link");
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.navigated, false);
  // The one that used to be wrong: a navigation that is never coming was reported as one
  // still on its way, which tells the model to go wait for a page that will never load.
  assert.equal(result.navigationPending, undefined);
  assert.deepEqual(result.navigationFailed, {
    url: "https://example.com/clientarea",
    reason: "net::ERR_BLOCKED_BY_CLIENT",
  });
  // ACTION_NAV_COMMIT_TIMEOUT_MS is 10s; anywhere near it means the race never woke up.
  assert.ok(elapsed < 3_000, `expected the failure to end the wait, took ${elapsed}ms`);
  assert.equal(fake.listeners.request.length, 0);
  assert.equal(fake.listeners.requestfailed.length, 0);
});

test("a navigation that turned into a download is not reported as a failure", async () => {
  const fake = navigatingPage({ commitAfterMs: null });
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;
  fake.page.mouse.down = async () => {
    fake.start();
    // Chromium aborts the navigation and hands the transfer to the download manager, so
    // the download arrives on the open side-effect window while the request fails.
    for (const sink of browser.sideEffectSinks) {
      sink.downloads.push({
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
        state: "pending",
      });
    }
    fake.fail("net::ERR_ABORTED");
  };

  const result = await browser.click("#download-link");

  assert.equal(result.navigationPending, undefined);
  // The download worked. Calling its aborted navigation a failure would describe a
  // successful transfer as a dead end.
  assert.equal(result.navigationFailed, undefined);
  assert.equal(result.downloads?.length, 1);
});

test("a navigation that retries after a failed attempt is not reported as failed", async () => {
  const fake = navigatingPage({ commitAfterMs: null });
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => fake.page;
  fake.page.mouse.down = async () => {
    fake.start();
    fake.fail("net::ERR_NAME_NOT_RESOLVED");
    // The second attempt lands, so the first one's failure describes nothing that stuck.
    setTimeout(() => {
      fake.state.url = "https://example.com/clientarea";
      fake.state.committed = true;
      for (const fn of [...fake.listeners.framenavigated]) fn(fake.page.mainFrame());
    }, 50);
  };

  const result = await browser.click("#retrying");

  assert.equal(result.navigated, true);
  assert.equal(result.navigationFailed, undefined);
  assert.equal(result.navigationPending, undefined);
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

test("snapshot re-scans a document that went away between its element reads", async () => {
  // readThroughNavigation covers the element query; these reads happen after it, and each
  // swallows its own error so one detached element costs only itself. A navigation fails
  // all of them at once, and the scan would otherwise report an empty page as an answer.
  const race = "Execution context was destroyed, most likely because of a navigation";
  const disposed = [];
  let scans = 0;
  let settled = 0;
  const handle = (id) => ({
    isVisible: async () => {
      if (scans === 1) throw new Error(race);
      return true;
    },
    evaluate: async () => ({
      tag: "button",
      explicitRole: "",
      hasList: false,
      multiple: false,
      size: 0,
      label: "Continue",
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
  const main = {
    url: () => "https://example.com/",
    name: () => "",
    parentFrame: () => null,
    locator: () => ({
      elementHandles: async () => {
        scans += 1;
        return [handle(scans)];
      },
    }),
  };
  const page = {
    frames: () => [main],
    mainFrame: () => main,
    ...NO_NAV,
    waitForLoadState: async () => { settled += 1; },
  };
  const browser = new ChromiumFishBrowser(config);
  browser.page = async () => page;

  const result = await browser.snapshot();
  assert.match(result, /^\[e1\] button "Continue"$/);
  assert.equal(scans, 2, "the raced scan describes a document that is gone");
  assert.equal(settled, 1, "the retry waits for the new document first");
  // The abandoned scan's handle is released; only the one backing e1 is still held.
  assert.deepEqual(disposed, [1]);
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
  const counts = { request: 0, framenavigated: 0, requestfailed: 0 };
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
  assert.deepEqual(
    counts,
    { request: 0, framenavigated: 0, requestfailed: 0 },
    "released as soon as the result is built",
  );

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
  assert.deepEqual(
    counts,
    { request: 0, framenavigated: 0, requestfailed: 0 },
    "detached once the window closes",
  );
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
