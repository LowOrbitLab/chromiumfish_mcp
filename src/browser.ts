import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { buildArgs, ChromiumFish } from "chromiumfish";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  Frame,
  Page,
  Request as PlaywrightRequest,
} from "playwright-core";
import { chromium } from "playwright-core";
import { snapshotRole } from "./aria.js";
import type { ServerConfig } from "./config.js";
import {
  checkboxClickCandidates,
  classifyChallenge,
  inferWidgetState,
  initialCursorPos,
  isCloudflareFrameUrl,
  isVerifyingPhase,
  looksCleared,
  snippet,
  warmUpPath,
  type ChallengeDetection,
  type ChallengeKind,
  type ChallengeSolveOptions,
  type ChallengeSolveResult,
  type WidgetBox,
  type WidgetState,
} from "./turnstile.js";

export type {
  ChallengeDetection,
  ChallengeKind,
  ChallengeSolveOptions,
  ChallengeSolveResult,
  WidgetBox,
  WidgetState,
};

export interface PageSummary {
  pageId: string;
  current: boolean;
  title: string;
  url: string;
}

/** Shared options for tools that change page state. */
export interface ActionOptions {
  /**
   * Also return a fresh snapshot of the resulting page, which saves the follow-up
   * snapshot round trip. Like any snapshot, it renumbers element refs.
   */
  returnSnapshot?: boolean;
}

/**
 * What an action did to the page. Callers read `navigated` / `newPages` instead of
 * spending a second round trip on snapshot or get_text just to learn whether the page
 * moved, which otherwise doubles the cost of every interaction.
 */
export interface ActionResult {
  ok: true;
  url: string;
  title: string;
  /**
   * True when the URL changed within the action's settle window. The navigation tools
   * report it unconditionally, since they always invalidate refs.
   */
  navigated: boolean;
  /** pageIds the action opened. The current page is never switched automatically. */
  newPages?: string[];
  /**
   * The action started a top-level navigation that had not committed when this result was
   * built, so url and title still describe the outgoing page. The action itself succeeded;
   * wait_for the destination rather than treating it as a no-op or retrying the action.
   */
  navigationPending?: boolean;
  snapshot?: string;
}

export interface SelectOptionResult extends ActionResult {
  selectedValues: string[];
}

export interface SetCheckedResult extends ActionResult {
  checked: boolean;
}

export interface UploadedFile {
  name: string;
  bytes: number;
}

export interface UploadFileResult extends ActionResult {
  /** Base names only: the host's directory layout never travels back to the caller. */
  files: UploadedFile[];
}

export interface PageListResult {
  running: boolean;
  pages: PageSummary[];
}

export interface NativeTaskResult {
  success: boolean;
  finalText: string;
  steps: number;
}

export interface FrameSummary {
  frameId: string;
  parentFrameId?: string;
  url: string;
  name: string;
  box?: { x: number; y: number; width: number; height: number };
}

interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
  frameUrl: string;
}

export interface ClickAtResult extends ActionResult {
  x: number;
  y: number;
}

export type ElementState = "attached" | "detached" | "visible" | "hidden";
export type LoadState = "load" | "domcontentloaded" | "networkidle";
export type SelectOptionMatch = "value" | "label";

export interface SnapshotOptions {
  frameId?: string;
  scope?: string;
  maxElements?: number;
  maxChars?: number;
}

export interface GetTextOptions {
  frameId?: string;
  selector?: string;
  maxChars?: number;
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** Crop to one element; mutually exclusive with fullPage. */
  target?: string;
  frameId?: string;
}

export interface Point {
  x: number;
  y: number;
}

/** Where a drag ends: onto another element, or by a viewport-space offset. */
export interface DragDestination {
  toTarget?: string;
  dx?: number;
  dy?: number;
}

export interface DragResult extends ActionResult {
  from: Point;
  to: Point;
}

export type WaitForCondition =
  | { kind: "element"; target: string; state?: ElementState; frameId?: string }
  | { kind: "text"; text: string; state?: "visible" | "hidden"; frameId?: string }
  | { kind: "url"; url: string }
  | { kind: "load"; state: LoadState }
  | { kind: "time"; timeMs: number };

export interface WaitForOptions {
  condition: WaitForCondition;
  timeoutMs: number;
}

export interface BrowserApi {
  listPages(): Promise<PageListResult>;
  openPage(url?: string): Promise<PageSummary>;
  selectPage(pageId: string): Promise<PageSummary>;
  closePage(pageId?: string): Promise<PageListResult>;
  navigate(url: string, options?: ActionOptions): Promise<ActionResult>;
  navigateBack(options?: ActionOptions): Promise<ActionResult>;
  navigateForward(options?: ActionOptions): Promise<ActionResult>;
  reload(options?: ActionOptions): Promise<ActionResult>;
  snapshot(options?: SnapshotOptions): Promise<string>;
  getText(options?: GetTextOptions): Promise<string>;
  takeScreenshot(options?: ScreenshotOptions): Promise<Buffer>;
  click(target: string, frameId?: string, options?: ActionOptions): Promise<ActionResult>;
  hover(target: string, frameId?: string, options?: ActionOptions): Promise<ActionResult>;
  selectOption(
    target: string,
    values: string[],
    matchBy: SelectOptionMatch,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<SelectOptionResult>;
  setChecked(
    target: string,
    checked: boolean,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<SetCheckedResult>;
  uploadFile(
    target: string,
    paths: string[],
    frameId?: string,
    options?: ActionOptions,
  ): Promise<UploadFileResult>;
  clickAt(x: number, y: number, options?: ActionOptions): Promise<ClickAtResult>;
  drag(
    target: string,
    destination: DragDestination,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<DragResult>;
  listFrames(options?: { includeBox?: boolean }): Promise<FrameSummary[]>;
  findChallenge(): Promise<ChallengeDetection>;
  solveChallenge(options?: ChallengeSolveOptions): Promise<ChallengeSolveResult>;
  typeText(
    target: string,
    text: string,
    clear: boolean,
    submit: boolean,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<ActionResult>;
  pressKey(key: string, options?: ActionOptions): Promise<ActionResult>;
  scroll(deltaX: number, deltaY: number, options?: ActionOptions): Promise<ActionResult>;
  waitFor(options: WaitForOptions, actionOptions?: ActionOptions): Promise<ActionResult>;
  evaluate(expression: string): Promise<string>;
  runTask(task: string, url: string | undefined, maxSteps: number): Promise<NativeTaskResult>;
  close(): Promise<void>;
}

type InteractiveHandle = ElementHandle<HTMLElement | SVGElement>;

/** Facts the single staleness evaluate collects, shared by every resolveTarget caller. */
interface TargetInfo {
  connected: boolean;
  fileInput: boolean;
  multiple: boolean;
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=combobox]",
  "[contenteditable=true]",
].join(",");

const DEFAULT_SNAPSHOT_ELEMENTS = 100;
const MAX_SNAPSHOT_ELEMENTS = 250;
const DEFAULT_SNAPSHOT_CHARS = 20_000;
const MIN_SNAPSHOT_CHARS = 5_000;
const HANDLE_BATCH_SIZE = 32;
const MAX_SCREENSHOT_PIXELS = 25_000_000;
const MAX_SCREENSHOT_DIMENSION = 20_000;
/**
 * Bound Playwright's auto-wait. playwright-core defaults action timeouts to 0 (no
 * timeout) — only @playwright/test imposes 30s — so an unmatched selector would hang the
 * tool call indefinitely. wait_for is the tool for elements that are genuinely slow.
 */
const LOCATOR_TIMEOUT_MS = 5_000;
/** Navigation is legitimately slower than element resolution, so it gets its own bound. */
const NAVIGATION_TIMEOUT_MS = 30_000;
const SNAPSHOT_TRUNCATION_MARKER = "narrow scope or adjust maxElements/maxChars";
/** Window an action gets to start a navigation before its result is read. */
const ACTION_SETTLE_MS = 150;
/** Upper bound on waiting for a navigation the action did start to become readable. */
const ACTION_LOAD_TIMEOUT_MS = 2_000;
/**
 * How long an action waits for a navigation it started to commit. Long enough for a slow
 * login POST or a redirect chain; past it the result says navigationPending instead of
 * describing the document that is on its way out.
 */
const ACTION_NAV_COMMIT_TIMEOUT_MS = 10_000;

/** Page state captured before an action so the result can report what changed. */
interface ActionBaseline {
  url: string;
  pages: Page[];
  /** Resolves once the main frame commits a new document. */
  committed: Promise<void>;
  /** A top-level navigation has been requested but has not committed yet. */
  pending: () => boolean;
  /** Detaches the listeners; every actionResult must call it. */
  release: () => void;
}

/**
 * Playwright's wording for "the document this call was evaluating in went away". A
 * navigation committing mid-query is a race, not a failure: the action that started it
 * succeeded, and asking again on the new document is the answer the caller wanted.
 * Deliberately excludes a closed page or browser, which no retry can help.
 */
function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Execution context was destroyed")
    || message.includes("Cannot find context with specified id")
    || message.includes("Execution context is not available in detached frame");
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const suffix = `\n\n[Content truncated; ${value.length} characters total]`;
  const contentLength = Math.max(0, max - suffix.length);
  return `${value.slice(0, contentLength)}${suffix.slice(0, max - contentLength)}`;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value === undefined || !Number.isFinite(value) ? fallback : value;
  return Math.min(Math.max(Math.trunc(resolved), min), max);
}

function jsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded ?? String(value);
}

export function assertNavigationUrl(rawUrl: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL; include http:// or https://");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Navigation supports only HTTP or HTTPS URLs");
  }
  if (url.username || url.password) {
    throw new Error("Navigation URLs cannot include a username or password");
  }
  if (allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    if (!allowed) throw new Error(`Target host ${host} is not permitted by --allowed-host`);
  }
  return url;
}

/**
 * Resolve an upload path and prove it sits inside a configured --upload-dir root.
 *
 * Uploading reads a host file and hands it to a remote origin, chosen from page content the
 * model is reading, so this is the boundary that keeps a prompt-injected page from asking
 * for ~/.ssh/id_rsa. Both the candidate and each root are realpath'd before comparison:
 * resolving only one side lets a symlink inside a root point anywhere on the disk, and
 * leaves roots that are themselves symlinks (macOS /tmp) failing to match their own files.
 *
 * Returns the size alongside the path so the caller does not stat the same file again.
 */
export async function assertUploadPath(
  rawPath: string,
  uploadDirs: string[],
): Promise<{ path: string; bytes: number }> {
  if (uploadDirs.length === 0) {
    throw new Error("Uploads are disabled; start the server with --upload-dir to enable them");
  }

  let file: string;
  let info: Stats;
  try {
    file = await realpath(rawPath);
    // Inside the same guard as realpath: the file can be removed between the two calls, and
    // a raw ENOENT here would bypass the message this function exists to produce.
    info = await stat(file);
  } catch {
    throw new Error(`Upload path does not exist: ${rawPath}`);
  }
  if (!info.isFile()) {
    throw new Error(`Upload path is not a regular file: ${rawPath}`);
  }

  for (const dir of uploadDirs) {
    // A root that has been renamed or removed cannot match; it must not abort the others.
    const root = await realpath(dir).catch(() => undefined);
    if (root === undefined) continue;
    const rel = relative(root, file);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return { path: file, bytes: info.size };
  }
  throw new Error(
    `Upload path ${rawPath} is outside every --upload-dir root (${uploadDirs.join(", ")}); `
    + "symlinks are resolved before this check, so a link out of a root is rejected too.",
  );
}

export class ChromiumFishBrowser implements BrowserApi {
  private browser?: Browser;
  private context?: BrowserContext;
  private currentPage?: Page;
  private readonly pageIds = new WeakMap<Page, string>();
  private nextPageId = 1;
  private readonly frameIds = new WeakMap<Frame, string>();
  private nextFrameId = 1;
  private readonly refs = new WeakMap<Page, Map<string, InteractiveHandle>>();
  /** Never reset, not even per page: reusing a number would make a stale ref resolve silently. */
  private nextRefId = 1;
  private readonly mousePositions = new WeakMap<Page, { x: number; y: number }>();
  /** Prevent concurrent solve_challenge runs from fighting over the same mouse. */
  private solveChallengeInFlight = false;

  constructor(private readonly config: ServerConfig) {}

  private nativeAgentArgs(): string[] {
    if (!this.config.allowNativeAgent) return [];
    return [
      "--disable-actor-safety-checks",
      `--agent-llm-url=${process.env.OPENAI_API_BASE ?? ""}`,
      `--agent-llm-key=${process.env.OPENAI_API_KEY ?? ""}`,
      `--agent-model=${process.env.OPENAI_API_MODEL ?? ""}`,
    ];
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && this.browser?.isConnected()) return this.context;
    const nativeAgentArgs = this.nativeAgentArgs();
    if (this.config.chromePath) {
      if (!existsSync(this.config.chromePath)) {
        throw new Error(`ChromiumFish executable does not exist: ${this.config.chromePath}`);
      }
      if (this.config.timezone === "auto") {
        throw new Error("--chrome-path does not support --timezone auto; specify an IANA time zone or system");
      }
      const env = this.config.timezone
        ? { ...(process.env as Record<string, string>), TZ: this.config.timezone }
        : undefined;
      this.browser = await chromium.launch({
        executablePath: this.config.chromePath,
        headless: this.config.headless,
        proxy: this.config.proxy,
        args: buildArgs({
          personaSeed: this.config.personaSeed,
          windowSize: this.config.windowSize,
          args: nativeAgentArgs,
        }),
        ...(env ? { env } : {}),
      });
    } else {
      this.browser = await ChromiumFish({
        personaSeed: this.config.personaSeed,
        headless: this.config.headless,
        windowSize: this.config.windowSize,
        version: this.config.browserVersion,
        timezone: this.config.timezone,
        proxy: this.config.proxy,
        args: nativeAgentArgs,
      });
    }
    this.context = await this.browser.newContext({
      viewport: {
        width: this.config.windowSize[0],
        height: this.config.windowSize[1],
      },
    });
    // Safety net for any auto-waiting call that does not pass an explicit timeout;
    // without it playwright-core would wait forever. Navigation keeps a looser bound.
    this.context.setDefaultTimeout(LOCATOR_TIMEOUT_MS);
    this.context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await this.installNavigationGuard(this.context);
    return this.context;
  }

  private async installNavigationGuard(context: BrowserContext): Promise<void> {
    if (this.config.allowedHosts.length === 0) return;
    await context.route("**/*", async (route) => {
      const request = route.request();
      let allow = true;
      if (request.isNavigationRequest()) {
        try {
          // Only top-level navigations are policed; subframes and assets pass through.
          const topLevel = request.frame().parentFrame() === null;
          if (topLevel) assertNavigationUrl(request.url(), this.config.allowedHosts);
        } catch {
          allow = false;
        }
      }
      try {
        await (allow ? route.continue() : route.abort("blockedbyclient"));
      } catch {
        // Route already handled or the page closed mid-flight; nothing actionable.
      }
    });
  }

  private trackPage(page: Page): void {
    this.pageId(page);
    page.once("close", () => {
      void this.clearRefs(page);
      if (this.currentPage === page) this.currentPage = undefined;
    });
  }

  private pageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = `page-${this.nextPageId++}`;
    this.pageIds.set(page, id);
    return id;
  }

  private frameId(frame: Frame): string {
    const existing = this.frameIds.get(frame);
    if (existing) return existing;
    const id = `frame-${this.nextFrameId++}`;
    this.frameIds.set(frame, id);
    return id;
  }

  private resolveFrame(page: Page, frameId?: string): Frame {
    const frame = frameId
      ? page.frames().find((candidate) => this.frameId(candidate) === frameId)
      : page.mainFrame();
    if (!frame) throw new Error(`Frame ${frameId} not found in the current page`);
    if (frameId && isCloudflareFrameUrl(frame.url())) {
      throw new Error(
        `DOM access to challenge frame ${frameId} is disabled; use find_challenge and solve_challenge`,
      );
    }
    return frame;
  }

  private async pageSummary(page: Page): Promise<PageSummary> {
    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    return {
      pageId: this.pageId(page),
      current: page === this.currentPage,
      title,
      url: page.url(),
    };
  }

  private async page(): Promise<Page> {
    const context = await this.ensureContext();
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    const existing = context.pages().find((page) => !page.isClosed());
    if (existing) {
      this.currentPage = existing;
      this.trackPage(existing);
      return existing;
    }
    this.currentPage = await context.newPage();
    this.trackPage(this.currentPage);
    return this.currentPage;
  }

  async listPages(): Promise<PageListResult> {
    if (!this.context || !this.browser?.isConnected()) {
      return { running: false, pages: [] };
    }
    const pages = await Promise.all(
      this.context.pages().filter((page) => !page.isClosed()).map((page) => this.pageSummary(page)),
    );
    return { running: true, pages };
  }

  async openPage(rawUrl?: string): Promise<PageSummary> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.trackPage(page);
    this.currentPage = page;
    if (rawUrl) {
      const url = assertNavigationUrl(rawUrl, this.config.allowedHosts);
      await page.goto(url.href, { waitUntil: "domcontentloaded" });
    }
    return this.pageSummary(page);
  }

  async selectPage(pageId: string): Promise<PageSummary> {
    const context = this.context;
    if (!context || !this.browser?.isConnected()) throw new Error("Browser is not running");
    const page = context.pages().find((candidate) => this.pageId(candidate) === pageId && !candidate.isClosed());
    if (!page) throw new Error(`Page ${pageId} not found`);
    this.currentPage = page;
    await page.bringToFront();
    return this.pageSummary(page);
  }

  async closePage(pageId?: string): Promise<PageListResult> {
    const context = this.context;
    if (!context || !this.browser?.isConnected()) throw new Error("Browser is not running");
    const page = pageId
      ? context.pages().find((candidate) => this.pageId(candidate) === pageId)
      : this.currentPage && !this.currentPage.isClosed()
        ? this.currentPage
        : context.pages().find((candidate) => !candidate.isClosed());
    if (!page || page.isClosed()) throw new Error(`Page ${pageId ?? "current"} not found`);
    await this.clearRefs(page);
    await page.close();
    if (this.currentPage === page) {
      this.currentPage = context.pages().filter((candidate) => !candidate.isClosed()).at(-1);
      await this.currentPage?.bringToFront().catch(() => undefined);
    }
    return this.listPages();
  }

  /**
   * Report a navigation in the same shape as actionResult, so a caller never has to
   * branch on which tool it called. `navigated` is unconditional rather than a URL
   * comparison: these tools always clear refs, so the question it answers - does the
   * caller need a fresh snapshot - is always yes, and a same-URL goto or reload would
   * otherwise report false while having invalidated every ref.
   *
   * Unlike actionResult this skips the settle window: goto, goBack, goForward, and
   * reload already awaited domcontentloaded, so waiting again only adds latency.
   */
  private async navigationResult(
    page: Page,
    priorPages: Page[],
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    const opened = this.openPages().filter((candidate) => !priorPages.includes(candidate));
    for (const candidate of opened) this.trackPage(candidate);

    const result: ActionResult = {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ""),
      navigated: true,
    };
    if (opened.length > 0) result.newPages = opened.map((candidate) => this.pageId(candidate));
    if (options.returnSnapshot) result.snapshot = await this.snapshot();
    return result;
  }

  /**
   * Snapshot the page state an action starts from, and arm the navigation listeners.
   *
   * They are armed here, before the action runs, because Playwright offers no way to ask
   * afterwards whether a navigation is in flight: the request can be issued and the document
   * torn down before the first read, and by then the only evidence has already gone past.
   */
  private actionBaseline(page: Page): ActionBaseline {
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let started = false;
    let done = false;
    const onRequest = (request: PlaywrightRequest) => {
      if (started || !request.isNavigationRequest()) return;
      // frame() throws once a frame is detached, which only means this is not the main one.
      try {
        if (request.frame() !== page.mainFrame()) return;
      } catch {
        return;
      }
      started = true;
    };
    const onNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      done = true;
      commit();
    };
    page.on("request", onRequest);
    page.on("framenavigated", onNavigated);

    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      page.off("request", onRequest);
      page.off("framenavigated", onNavigated);
    };
    // These listeners cannot change any outcome once the commit window has closed, so that
    // window is their lifetime. Enforcing it here rather than relying on release() alone is
    // what keeps an action that throws on its way to actionResult — a setInputFiles timeout,
    // a failed selectOption — from leaving a pair attached for the rest of the session.
    const expiry = setTimeout(detach, ACTION_NAV_COMMIT_TIMEOUT_MS + ACTION_LOAD_TIMEOUT_MS);
    expiry.unref?.();

    return {
      url: page.url(),
      pages: this.openPages(),
      committed,
      pending: () => started && !done,
      release: () => {
        clearTimeout(expiry);
        detach();
      },
    };
  }

  /**
   * Run a read that evaluates in the page, retrying once if a navigation destroyed the
   * context underneath it. Without this a snapshot or get_text issued in the window after a
   * click that navigates fails outright, which reads as "the action broke" when the action
   * in fact worked and the page simply moved on.
   */
  private async readThroughNavigation<T>(page: Page, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!isNavigationRace(error)) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: ACTION_LOAD_TIMEOUT_MS })
        .catch(() => undefined);
      return read();
    }
  }

  private openPages(): Page[] {
    if (!this.context || !this.browser?.isConnected()) return [];
    return this.context.pages().filter((page) => !page.isClosed());
  }

  /**
   * Report the page state an action produced. Without this, callers must spend a second
   * round trip on snapshot or get_text just to learn whether the page moved, which
   * doubles the cost of every interaction.
   */
  private async actionResult(
    page: Page,
    baseline: ActionBaseline,
    options: ActionOptions = {},
  ): Promise<ActionResult> {
    try {
      // A click or Enter commits its navigation after the input event resolves, so settle
      // briefly first. Every step is best-effort: an action that closed the page must still
      // report its result rather than failing after the side effect already happened.
      await page.waitForTimeout(ACTION_SETTLE_MS).catch(() => undefined);

      // waitForLoadState answers for the *current* document. While a navigation is in
      // flight that is still the old one, already loaded, so it returns within a millisecond
      // and every read below would describe the page that is about to be replaced: the old
      // url, Chromium's "Loading <url>" placeholder title, navigated: false for a click that
      // did navigate, and a snapshot racing the teardown. Wait for the commit itself, and
      // only when a top-level navigation request was actually seen, so a click that changes
      // nothing still returns in the settle window.
      if (baseline.pending()) {
        await Promise.race([
          baseline.committed,
          page.waitForTimeout(ACTION_NAV_COMMIT_TIMEOUT_MS).catch(() => undefined),
        ]).catch(() => undefined);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: ACTION_LOAD_TIMEOUT_MS })
        .catch(() => undefined);

      // Still in flight after the bound above: a slow endpoint or a redirect chain. Report
      // that rather than let the stale reads below read as "the action did nothing".
      const navigationPending = baseline.pending();
      const url = page.url();
      const navigated = url !== baseline.url;
      // The previous document is gone; its handles would only fail the staleness check later.
      if (navigated) await this.clearRefs(page);

      const opened = this.openPages().filter((candidate) => !baseline.pages.includes(candidate));
      for (const candidate of opened) this.trackPage(candidate);

      const result: ActionResult = {
        ok: true,
        url,
        title: await this.settledTitle(page, navigationPending),
        navigated,
      };
      if (navigationPending) result.navigationPending = true;
      if (opened.length > 0) result.newPages = opened.map((candidate) => this.pageId(candidate));
      if (options.returnSnapshot) result.snapshot = await this.snapshot();
      return result;
    } finally {
      baseline.release();
    }
  }

  /**
   * Chromium reports "Loading <url>" as the title of a document that has not arrived yet.
   * That is a placeholder, not the page's title, and returning it invites a caller to match
   * on it or record it as the destination's name.
   */
  private async settledTitle(page: Page, navigationPending: boolean): Promise<string> {
    const title = await page.title().catch(() => "");
    if (navigationPending && /^Loading https?:\/\//.test(title)) return "";
    return title;
  }

  async navigate(rawUrl: string, options?: ActionOptions): Promise<ActionResult> {
    const url = assertNavigationUrl(rawUrl, this.config.allowedHosts);
    const page = await this.page();
    // Captured after page(), so the page a lazy browser start just created is not
    // reported as one this navigation opened.
    const priorPages = this.openPages();
    await this.clearRefs(page);
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    return this.navigationResult(page, priorPages, options);
  }

  async navigateBack(options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const priorPages = this.openPages();
    await this.clearRefs(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    return this.navigationResult(page, priorPages, options);
  }

  async navigateForward(options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const priorPages = this.openPages();
    await this.clearRefs(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    return this.navigationResult(page, priorPages, options);
  }

  async reload(options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const priorPages = this.openPages();
    await this.clearRefs(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    return this.navigationResult(page, priorPages, options);
  }

  private async clearRefs(page: Page): Promise<void> {
    const refs = this.refs.get(page);
    this.refs.delete(page);
    if (!refs) return;
    await this.disposeHandles([...refs.values()]);
  }

  private async disposeHandles(handles: InteractiveHandle[]): Promise<void> {
    for (let index = 0; index < handles.length; index += HANDLE_BATCH_SIZE) {
      await Promise.all(
        handles.slice(index, index + HANDLE_BATCH_SIZE)
          .map((handle) => handle.dispose().catch(() => undefined)),
      );
    }
  }

  async snapshot(options: SnapshotOptions = {}): Promise<string> {
    const page = await this.page();
    await this.clearRefs(page);
    const frame = this.resolveFrame(page, options.frameId);
    const locator = options.scope
      ? frame.locator(options.scope).locator(INTERACTIVE_SELECTOR)
      : frame.locator(INTERACTIVE_SELECTOR);
    const handles = await this.readThroughNavigation(
      page,
      async () => await locator.elementHandles() as InteractiveHandle[],
    );
    const maxElements = clampInteger(
      options.maxElements,
      DEFAULT_SNAPSHOT_ELEMENTS,
      1,
      MAX_SNAPSHOT_ELEMENTS,
    );
    const maxChars = clampInteger(
      options.maxChars,
      DEFAULT_SNAPSHOT_CHARS,
      MIN_SNAPSHOT_CHARS,
      this.config.maxTextChars,
    );
    const refs = new Map<string, InteractiveHandle>();
    const retained = new Set<InteractiveHandle>();
    const lines: string[] = [];
    let outputChars = 0;
    let truncated = false;
    let completed = false;

    try {
      outer: for (let start = 0; start < handles.length; start += HANDLE_BATCH_SIZE) {
        const batch = handles.slice(start, start + HANDLE_BATCH_SIZE);
        const visible = await Promise.all(
          batch.map((handle) => handle.isVisible().catch(() => false)),
        );
        for (let offset = 0; offset < batch.length; offset += 1) {
          if (!visible[offset]) continue;
          if (refs.size >= maxElements) {
            truncated = true;
            break outer;
          }

          const handle = batch[offset];
          if (!handle) continue;
          const info = await handle.evaluate((element) => {
            const html = element as HTMLElement;
            const input = element instanceof HTMLInputElement ? element : undefined;
            const textarea = element instanceof HTMLTextAreaElement ? element : undefined;
            const select = element instanceof HTMLSelectElement ? element : undefined;
            const labels = input?.labels ?? textarea?.labels ?? select?.labels;
            const type = input?.type.toLowerCase() ?? "";
            const label = html.getAttribute("aria-label")
              || labels?.[0]?.textContent
              || (["button", "submit", "reset"].includes(type) ? input?.value : "")
              || input?.placeholder
              || textarea?.placeholder
              || html.innerText
              || html.getAttribute("title")
              || "";
            const ariaChecked = html.getAttribute("aria-checked");
            const ariaExpanded = html.getAttribute("aria-expanded");
            const checked = input && ["checkbox", "radio"].includes(type)
              ? input.checked
              : ariaChecked === "true"
                ? true
                : ariaChecked === "false"
                  ? false
                  : null;
            const value = input && !["password", "checkbox", "radio", "file", "button", "submit", "reset"].includes(type)
              ? input.value
              : textarea
                ? textarea.value
                : null;
            return {
              // Raw facts only; the HTML-to-ARIA mapping lives in aria.ts so it can be
              // unit-tested without a DOM.
              tag: html.tagName.toLowerCase().slice(0, 40),
              explicitRole: (html.getAttribute("role") ?? "").trim().toLowerCase().slice(0, 40),
              hasList: Boolean(input?.hasAttribute("list")),
              multiple: Boolean(select?.multiple),
              size: select?.size ?? 0,
              label: label.trim().replace(/\s+/g, " ").slice(0, 120),
              href: element instanceof HTMLAnchorElement ? element.href.slice(0, 300) : "",
              disabled: html.getAttribute("aria-disabled") === "true"
                || ("disabled" in html && Boolean((html as HTMLButtonElement).disabled)),
              type,
              value: value?.slice(0, 120) ?? null,
              passwordSet: type === "password" && Boolean(input?.value),
              checked,
              selected: select
                ? Array.from(select.selectedOptions).map((option) => option.value.slice(0, 120)).slice(0, 20)
                : [],
              selectedCount: select?.selectedOptions.length ?? 0,
              options: select
                ? Array.from(select.options).slice(0, 20).map((option) => ({
                  value: option.value.slice(0, 120),
                  label: option.label.trim().replace(/\s+/g, " ").slice(0, 80),
                }))
                : [],
              optionCount: select?.options.length ?? 0,
              expanded: ariaExpanded === "true"
                ? true
                : ariaExpanded === "false"
                  ? false
                  : null,
            };
          }).catch(() => null);
          if (!info) continue;

          // Monotonic across every snapshot and page: a number is never reused, so a
          // reference held from an earlier snapshot fails loudly in resolveTarget instead
          // of silently resolving to whatever element now occupies that position.
          const ref = `e${this.nextRefId++}`;
          const suffix = [
            info.type ? `type=${info.type}` : "",
            info.disabled ? "disabled" : "",
            info.checked === true ? "checked" : info.checked === false ? "unchecked" : "",
            info.expanded === true ? "expanded" : info.expanded === false ? "collapsed" : "",
            info.value !== null ? `value=${JSON.stringify(info.value)}` : "",
            info.passwordSet ? "value=<redacted>" : "",
            info.selected.length > 0 ? `selected=${JSON.stringify(info.selected)}` : "",
            info.selectedCount > info.selected.length
              ? `selectedShown=${info.selected.length}/${info.selectedCount}`
              : "",
            info.options.length > 0 ? `options=${JSON.stringify(info.options)}` : "",
            info.optionCount > info.options.length
              ? `optionsShown=${info.options.length}/${info.optionCount}`
              : "",
            info.href ? `-> ${info.href}` : "",
          ]
            .filter(Boolean)
            .join(" ");
          let line = `[${ref}] ${snapshotRole(info)} ${JSON.stringify(info.label)}${suffix ? ` ${suffix}` : ""}`;
          const separatorChars = lines.length > 0 ? 1 : 0;
          if (line.length + separatorChars > maxChars && lines.length === 0) {
            line = `${line.slice(0, Math.max(0, maxChars - 18))} [line truncated]`;
            truncated = true;
          } else if (outputChars + separatorChars + line.length > maxChars) {
            truncated = true;
            break outer;
          }

          refs.set(ref, handle);
          retained.add(handle);
          lines.push(line);
          outputChars += separatorChars + line.length;
          if (truncated) break outer;
        }
      }

      this.refs.set(page, refs);
      completed = true;
      if (!truncated) {
        // Per-line accounting already kept the body within maxChars.
        return lines.length > 0 ? lines.join("\n") : "(No visible interactive elements)";
      }
      // Append the marker and, if the body was char-bound, drop trailing lines so the
      // marker always survives the budget instead of being clipped away.
      const marker = `[Snapshot truncated after ${refs.size} elements; ${SNAPSHOT_TRUNCATION_MARKER}]`;
      let output = lines.length > 0 ? `${lines.join("\n")}\n${marker}` : marker;
      while (output.length > maxChars && lines.length > 0) {
        lines.pop();
        output = lines.length > 0 ? `${lines.join("\n")}\n${marker}` : marker;
      }
      return output;
    } finally {
      await this.disposeHandles(
        handles.filter((handle) => !completed || !retained.has(handle)),
      );
    }
  }

  async getText(options: GetTextOptions = {}): Promise<string> {
    const page = await this.page();
    const frame = this.resolveFrame(page, options.frameId);
    const locator = frame.locator(options.selector ?? "body").first();
    // Bound the auto-wait so a non-matching selector fails fast instead of hanging
    // for Playwright's default timeout.
    const read = () => locator.innerText({ timeout: LOCATOR_TIMEOUT_MS });
    const text = options.selector
      ? await this.readThroughNavigation(page, read)
      // No body text is a valid answer for the default scope, but the retry has to run
      // first: catching here directly would turn a navigation race into a silent "".
      : await this.readThroughNavigation(page, read).catch(() => "");
    const maxChars = clampInteger(options.maxChars, DEFAULT_SNAPSHOT_CHARS, 100, this.config.maxTextChars);
    return clip(text, maxChars);
  }

  async takeScreenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const page = await this.page();
    const fullPage = options.fullPage ?? false;
    if (options.target !== undefined) {
      if (fullPage) {
        throw new Error("take_screenshot cannot combine target with fullPage; an element capture is already cropped");
      }
      return this.elementScreenshot(page, options.target, options.frameId);
    }
    const metrics = await page.evaluate(() => ({
      scale: window.devicePixelRatio || 1,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    }));
    const viewport = page.viewportSize();
    const cssWidth = fullPage ? metrics.scrollWidth : viewport?.width ?? metrics.innerWidth;
    const cssHeight = fullPage ? metrics.scrollHeight : viewport?.height ?? metrics.innerHeight;
    // The encoded PNG is CSS pixels times the device scale factor on each axis.
    const scale = Number.isFinite(metrics.scale) && metrics.scale > 0 ? metrics.scale : 1;
    const width = Math.ceil(cssWidth * scale);
    const height = Math.ceil(cssHeight * scale);
    const pixels = width * height;
    if (
      width > MAX_SCREENSHOT_DIMENSION
      || height > MAX_SCREENSHOT_DIMENSION
      || pixels > MAX_SCREENSHOT_PIXELS
    ) {
      const advice = fullPage ? "capture the viewport or reduce --window-size" : "reduce --window-size";
      throw new Error(
        `${fullPage ? "Full-page" : "Viewport"} screenshot is too large (${width}x${height}); ${advice}`,
      );
    }
    return page.screenshot({ type: "png", fullPage });
  }

  /**
   * Crop to one element instead of shipping a whole viewport PNG to answer a question about
   * a single control.
   *
   * The element is deliberately not scrolled into view here. boundingBox reports the same
   * width and height whether or not the element is on screen, and those are the only figures
   * the budget needs, so scrolling would buy nothing — while making a display:none target
   * spend the full locator timeout before failing, instead of failing at once on a null box.
   *
   * Playwright's own screenshot does scroll, and does not put the page back, so the scroll
   * offset is captured and restored around it. take_screenshot is annotated readOnlyHint,
   * and viewport coordinates the caller already holds — a widget box from find_challenge,
   * a frame box from list_frames — silently address the wrong pixels once the page moves
   * under them.
   */
  private async elementScreenshot(page: Page, target: string, frameId?: string): Promise<Buffer> {
    const handle = await this.resolveTarget(page, target, frameId);
    const box = await handle.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error(`Target ${target} has no visible box to capture`);
    }
    const scale = await page.evaluate(() => window.devicePixelRatio || 1)
      .then((value) => Number.isFinite(value) && value > 0 ? value : 1)
      .catch(() => 1);
    const width = Math.ceil(box.width * scale);
    const height = Math.ceil(box.height * scale);
    if (
      width > MAX_SCREENSHOT_DIMENSION
      || height > MAX_SCREENSHOT_DIMENSION
      || width * height > MAX_SCREENSHOT_PIXELS
    ) {
      throw new Error(
        `Element screenshot is too large (${width}x${height}); capture a smaller descendant instead`,
      );
    }

    const origin = await page.evaluate(() => [window.scrollX, window.scrollY] as [number, number])
      .catch(() => undefined);
    try {
      return await handle.screenshot({ type: "png" });
    } finally {
      // Best effort: a capture that succeeded must still be returned even if the page went
      // away before the scroll could be put back.
      if (origin) {
        await page.evaluate(([x, y]) => window.scrollTo(x, y), origin).catch(() => undefined);
      }
    }
  }

  /** Reference numbers are never reused, so an unknown one is always from an earlier snapshot. */
  private unknownRefError(page: Page, target: string): Error {
    const keys = [...this.refs.get(page)?.keys() ?? []];
    const scope = keys.length > 0
      ? `the current snapshot of this page covers ${keys[0]}-${keys.at(-1)}`
      : "this page has no current snapshot";
    return new Error(
      `Unknown element reference ${target}; ${scope}. Reference numbers are never reused, and `
      + "every snapshot numbers its output afresh, so this one belongs to an earlier snapshot. "
      + "A selector built from the role and label snapshot printed — role=button[name=\"Save\"] "
      + "— stays valid across snapshots and re-renders; otherwise call snapshot again and use a "
      + "reference from its output.",
    );
  }

  /**
   * Clicking a file input cannot open anything: Playwright only intercepts the chooser
   * while a filechooser listener is registered, and this server registers none. Headless
   * therefore swallows the click and actionResult reports an ordinary ok/navigated:false,
   * which reads as success and leaves the caller waiting on an upload that never starts.
   * Failing here converts that silent no-op into a message naming the tool that works.
   */
  private fileInputClickError(target: string): Error {
    const enabled = this.config.uploadDirs.length > 0
      ? "Use upload_file instead; clicking cannot attach a file."
      : "Attaching files needs the upload_file tool, which this server did not register "
        + "because it was started without --upload-dir.";
    return new Error(`Target ${target} is a file input. ${enabled}`);
  }

  private async resolveTarget(
    page: Page,
    target: string,
    frameId?: string,
    options: { rejectFileInput?: boolean } = {},
  ): Promise<InteractiveHandle> {
    return (await this.resolveTargetWithInfo(page, target, frameId, options)).handle;
  }

  /**
   * As resolveTarget, but hands back the facts the staleness evaluate already gathered so a
   * caller that needs them does not pay a second round trip to ask the same element again.
   */
  private async resolveTargetWithInfo(
    page: Page,
    target: string,
    frameId?: string,
    options: { rejectFileInput?: boolean } = {},
  ): Promise<{ handle: InteractiveHandle; info: TargetInfo }> {
    const ref = this.refs.get(page)?.get(target);
    if (ref && frameId) {
      const requestedFrame = this.resolveFrame(page, frameId);
      const ownerFrame = await ref.ownerFrame();
      if (ownerFrame !== requestedFrame) {
        throw new Error(`Target ${target} does not belong to frame ${frameId}`);
      }
    }
    if (!ref && /^e\d+$/.test(target)) throw this.unknownRefError(page, target);
    const handle = ref ?? await this.resolveFrame(page, frameId).locator(target).first()
      .elementHandle({ timeout: LOCATOR_TIMEOUT_MS });
    if (!handle) throw new Error(`Target ${target} not found; call snapshot again after the page changes`);
    // One round trip carries every fact; the staleness check already cost an evaluate, so
    // the file-input guard and upload_file's multiple check ride along rather than each
    // adding a round trip of their own.
    const info = await handle.evaluate((element) => {
      const input = element instanceof HTMLInputElement ? element : undefined;
      return {
        connected: element.isConnected,
        fileInput: input?.type.toLowerCase() === "file",
        multiple: Boolean(input?.multiple),
      };
    }).catch(() => null);
    if (!info?.connected) {
      throw new Error(
        `Target ${target} is stale: the element it pointed at was replaced, which a re-render `
        + "does on every keystroke in some forms. A selector built from the role and label "
        + "snapshot already printed survives that — role=textbox[name=\"Email\"] — and costs "
        + "no extra call. Otherwise call snapshot again for fresh references.",
      );
    }
    if (info.fileInput && options.rejectFileInput) throw this.fileInputClickError(target);
    return { handle: handle as InteractiveHandle, info };
  }

  private async moveMouse(page: Page, x: number, y: number, steps = 12): Promise<void> {
    const start = this.mousePositions.get(page) ?? { x: 0, y: 0 };
    const control = {
      x: (start.x + x) / 2 + (Math.random() - 0.5) * 80,
      y: (start.y + y) / 2 + (Math.random() - 0.5) * 80,
    };
    const total = Math.max(4, steps);
    for (let index = 1; index <= total; index += 1) {
      const t = index / total;
      const inverse = 1 - t;
      await page.mouse.move(
        inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * x,
        inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * y,
      );
    }
    this.mousePositions.set(page, { x, y });
  }

  private async moveTo(page: Page, handle: InteractiveHandle): Promise<void> {
    await handle.scrollIntoViewIfNeeded({ timeout: LOCATOR_TIMEOUT_MS });
    const box = await handle.boundingBox();
    if (!box) throw new Error("Target is not currently clickable");
    const destination = this.pointInBox(box);
    await this.moveMouse(page, destination.x, destination.y, 12);
  }

  /** Jittered point inside a box, matching how moveTo picks its click point. */
  private pointInBox(box: { x: number; y: number; width: number; height: number }): Point {
    return {
      x: box.x + box.width * (0.35 + Math.random() * 0.3),
      y: box.y + box.height * (0.35 + Math.random() * 0.3),
    };
  }

  private async clickHandle(page: Page, handle: InteractiveHandle): Promise<void> {
    await this.moveTo(page, handle);
    await page.mouse.down();
    await page.waitForTimeout(45 + Math.floor(Math.random() * 70));
    await page.mouse.up();
  }

  async click(target: string, frameId?: string, options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId, { rejectFileInput: true });
    const baseline = this.actionBaseline(page);
    await this.clickHandle(page, handle);
    return this.actionResult(page, baseline, options);
  }

  async hover(target: string, frameId?: string, options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    const baseline = this.actionBaseline(page);
    await this.moveTo(page, handle);
    return this.actionResult(page, baseline, options);
  }

  async selectOption(
    target: string,
    values: string[],
    matchBy: SelectOptionMatch,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<SelectOptionResult> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    const baseline = this.actionBaseline(page);
    const requested = values.map((value) => matchBy === "label" ? { label: value } : { value });
    const selectedValues = await handle.selectOption(requested, { timeout: LOCATOR_TIMEOUT_MS });
    return { ...await this.actionResult(page, baseline, options), selectedValues };
  }

  async setChecked(
    target: string,
    checked: boolean,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<SetCheckedResult> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    const kind = await handle.evaluate((element) => {
      if (element instanceof HTMLInputElement) return element.type.toLowerCase();
      return element.getAttribute("role")?.toLowerCase() ?? "";
    });
    if (kind === "radio" && !checked) {
      throw new Error(`Radio target ${target} cannot be unchecked directly; select another radio option instead`);
    }
    const baseline = this.actionBaseline(page);
    let actual = await handle.isChecked();
    if (actual !== checked) {
      await this.clickHandle(page, handle);
      actual = await handle.isChecked();
    }
    if (actual !== checked) {
      throw new Error(`Target ${target} did not reach the requested checked state`);
    }
    return { ...await this.actionResult(page, baseline, options), checked: actual };
  }

  async uploadFile(
    target: string,
    paths: string[],
    frameId?: string,
    options?: ActionOptions,
  ): Promise<UploadFileResult> {
    const page = await this.page();
    const { handle, info } = await this.resolveTargetWithInfo(page, target, frameId);
    if (!info.fileInput) {
      throw new Error(
        `Target ${target} is not a file input. Target the input[type=file] itself — a hidden `
        + "one is still reachable by CSS selector, since attaching does not require visibility.",
      );
    }
    if (paths.length > 1 && !info.multiple) {
      throw new Error(`Target ${target} accepts a single file; it is not marked multiple`);
    }

    // Every path clears the allowlist before the page sees any of them, so a list with one
    // bad entry attaches nothing rather than half of what was asked for.
    const files: { path: string; bytes: number }[] = [];
    for (const path of paths) {
      files.push(await assertUploadPath(path, this.config.uploadDirs));
    }

    const baseline = this.actionBaseline(page);
    await handle.setInputFiles(files.map((file) => file.path), { timeout: LOCATOR_TIMEOUT_MS });
    return {
      ...await this.actionResult(page, baseline, options),
      files: files.map((file) => ({ name: basename(file.path), bytes: file.bytes })),
    };
  }

  async clickAt(x: number, y: number, options?: ActionOptions): Promise<ClickAtResult> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("click_at requires finite numeric x/y coordinates");
    }
    const page = await this.page();
    const viewport = page.viewportSize();
    if (viewport) {
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
        throw new Error(
          `Coordinates (${x}, ${y}) are outside the ${viewport.width}x${viewport.height} viewport`,
        );
      }
    }
    const baseline = this.actionBaseline(page);
    await this.moveMouse(page, x, y, 14);
    await page.waitForTimeout(40 + Math.floor(Math.random() * 90));
    await page.mouse.down();
    await page.waitForTimeout(45 + Math.floor(Math.random() * 70));
    await page.mouse.up();
    return { ...await this.actionResult(page, baseline, options), x, y };
  }

  async drag(
    target: string,
    destination: DragDestination,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<DragResult> {
    const { toTarget, dx, dy } = destination;
    const hasOffset = dx !== undefined || dy !== undefined;
    if (hasOffset === (toTarget !== undefined)) {
      throw new Error("drag needs exactly one destination: either toTarget, or dx/dy");
    }
    if (hasOffset && (!Number.isFinite(dx ?? 0) || !Number.isFinite(dy ?? 0))) {
      throw new Error("drag requires finite numeric dx/dy offsets");
    }

    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    // Scrolls the source into view and seeds the cursor on it, so the press below lands
    // where the drag is supposed to start.
    await this.moveTo(page, handle);
    const from = this.mousePositions.get(page) ?? { x: 0, y: 0 };

    let to: Point;
    if (toTarget !== undefined) {
      const destHandle = await this.resolveTarget(page, toTarget, frameId);
      // Deliberately not scrolled into view: scrolling now would slide the source out from
      // under the cursor. Both ends have to be on screen at once for a drag to mean anything.
      const box = await destHandle.boundingBox();
      if (!box) throw new Error(`Drag destination ${toTarget} is not visible`);
      to = this.pointInBox(box);
    } else {
      to = { x: from.x + (dx ?? 0), y: from.y + (dy ?? 0) };
    }

    const viewport = page.viewportSize();
    if (viewport && (to.x < 0 || to.y < 0 || to.x > viewport.width || to.y > viewport.height)) {
      throw new Error(
        `Drag would end at (${Math.round(to.x)}, ${Math.round(to.y)}), outside the `
        + `${viewport.width}x${viewport.height} viewport; scroll both ends into view first`,
      );
    }

    const baseline = this.actionBaseline(page);
    await page.mouse.down();
    // A press that jumps straight to the release point reads as synthetic. Pause as a hand
    // would before pulling, then follow moveMouse's curved, jittered path — sliders that
    // score trajectory reject the linear interpolation locator.dragTo would produce.
    await page.waitForTimeout(90 + Math.floor(Math.random() * 120));
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    await this.moveMouse(page, to.x, to.y, Math.max(14, Math.min(40, Math.round(distance / 18))));
    await page.waitForTimeout(60 + Math.floor(Math.random() * 90));
    await page.mouse.up();
    return { ...await this.actionResult(page, baseline, options), from, to };
  }

  private async frameBox(
    frame: Frame,
    options: { scroll?: boolean } = {},
  ): Promise<FrameBox | undefined> {
    try {
      if (options.scroll) {
        await frame.locator("body").scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => undefined);
      }
      const box = await frame.locator("body").boundingBox({ timeout: 1200 });
      if (!box || box.width <= 0 || box.height <= 0) return undefined;
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        frameUrl: frame.url(),
      };
    } catch {
      return undefined;
    }
  }

  async listFrames(options: { includeBox?: boolean } = {}): Promise<FrameSummary[]> {
    const includeBox = options.includeBox === true;
    const page = await this.page();
    const frames = page.frames();
    const summary = (frame: Frame): Omit<FrameSummary, "box"> => {
      const parent = frame.parentFrame();
      return {
        frameId: this.frameId(frame),
        ...(parent ? { parentFrameId: this.frameId(parent) } : {}),
        url: frame.url(),
        name: frame.name(),
      };
    };
    if (!includeBox) {
      return frames.map(summary);
    }
    // Bounding boxes only; do not scroll frames during listing (avoids layout thrash).
    const boxes = await Promise.all(frames.map(async (frame) => ({
      frame,
      box: await this.frameBox(frame, { scroll: false }),
    })));
    return boxes.map(({ frame, box }) => ({
      ...summary(frame),
      ...(box ? { box: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
    }));
  }

  private async readTurnstileToken(page: Page, title: string): Promise<string> {
    // Avoid probing challenge-related inputs while still on a CF gate page.
    // A/B: evaluateAll on cf-turnstile-response / cf-chl-widget* before click => 0/3 pass;
    // same click path without the probe => 3/3 pass.
    if (/just a moment|\u5b89\u5168\u9a8c\u8bc1|checking your browser|performing security verification/i.test(title)) {
      return "";
    }

    // Prefer a single lightweight read after leaving the gate.
    const value = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("input, textarea"));
      for (const node of nodes) {
        const el = node as HTMLInputElement | HTMLTextAreaElement;
        const key = `${el.name || ""} ${el.id || ""}`.toLowerCase();
        if (!key.includes("turnstile") && !key.includes("cf-chl")) continue;
        if (!key.includes("response")) continue;
        const v = (el.value || "").trim();
        if (v.length > 10) return v;
      }
      return "";
    }).catch(() => "");
    return value;
  }

  private async readBody(page: Page): Promise<string> {
    return page.locator("body").innerText().catch(() => "");
  }

  private async findTurnstileWidget(page: Page): Promise<WidgetBox | undefined> {
    const preferred = page.frames().filter((frame) => isCloudflareFrameUrl(frame.url()));
    const ordered = [
      ...preferred,
      ...page.frames().filter((frame) => !preferred.includes(frame) && frame !== page.mainFrame()),
    ];
    let fallback: WidgetBox | undefined;
    for (const frame of ordered) {
      const box = await this.frameBox(frame, { scroll: false });
      if (!box) continue;
      // Interactive Turnstile widget is typically ~300x65; ignore full-page frames.
      if (box.width >= 200 && box.width <= 420 && box.height >= 50 && box.height <= 120) {
        return box;
      }
      if (isCloudflareFrameUrl(frame.url()) && box.width >= 120 && box.width <= 500 && box.height >= 40 && box.height <= 200) {
        fallback ??= box;
      }
    }
    return fallback;
  }

  private async ensureWidgetInViewport(page: Page, widget: WidgetBox): Promise<WidgetBox> {
    const viewport = page.viewportSize();
    if (!viewport) return widget;
    const margin = 12;
    const fullyVisible =
      widget.x >= margin
      && widget.y >= margin
      && widget.x + widget.width <= viewport.width - margin
      && widget.y + widget.height <= viewport.height - margin;
    if (fullyVisible) return widget;

    // Scroll the challenge frame body into view, then re-measure.
    for (const frame of page.frames()) {
      if (frame.url() !== widget.frameUrl && !isCloudflareFrameUrl(frame.url())) continue;
      await this.frameBox(frame, { scroll: true });
    }
    // Also nudge main page scroll toward widget center.
    await page.evaluate(({ x, y }) => {
      const targetY = window.scrollY + y - window.innerHeight / 2;
      window.scrollTo(0, Math.max(0, targetY));
    }, { x: widget.x + widget.width / 2, y: widget.y + widget.height / 2 }).catch(() => undefined);

    await page.waitForTimeout(120);
    return (await this.findTurnstileWidget(page)) ?? widget;
  }

  private async observeChallenge(page: Page): Promise<{
    detection: ChallengeDetection;
    kind: ChallengeKind;
    widgetState: WidgetState;
    tokenPresent: boolean;
    hasChallengeFrame: boolean;
    bodyText: string;
  }> {
    const title = await page.title().catch(() => "");
    const url = page.url();
    const bodyText = await this.readBody(page);
    const frameUrls = page.frames().map((frame) => frame.url());
    const hasChallengeFrame = frameUrls.some((frameUrl) => isCloudflareFrameUrl(frameUrl));
    const token = await this.readTurnstileToken(page, title);
    const tokenPresent = token.length > 10;
    // Challenge-frame text is deliberately not read: probing challenges.cloudflare.com
    // frames before clearance collapses success rates, so widget state relies on token
    // presence and main-document signals only.
    const widgetState = inferWidgetState({
      tokenPresent,
      hasChallengeFrame,
      mainBodyText: bodyText,
    });
    const classified = classifyChallenge({
      title,
      url,
      bodyText,
      frameUrls,
      tokenPresent,
      widgetState,
    });
    const widget = (classified.present || widgetState === "success")
      ? await this.findTurnstileWidget(page)
      : undefined;

    // If token/success already, force not-present for agent simplicity.
    const present = tokenPresent || widgetState === "success" ? false : classified.present;
    const kind = present ? classified.kind : "none";

    return {
      kind,
      widgetState,
      tokenPresent,
      hasChallengeFrame,
      bodyText,
      detection: {
        present,
        kind,
        widgetState,
        title,
        url,
        bodySnippet: snippet(bodyText),
        tokenPresent,
        ...(widget ? { widget } : {}),
        frames: frameUrls.map((frameUrl) => ({ url: frameUrl })),
      },
    };
  }

  async findChallenge(): Promise<ChallengeDetection> {
    const page = await this.page();
    return (await this.observeChallenge(page)).detection;
  }

  async solveChallenge(options: ChallengeSolveOptions = {}): Promise<ChallengeSolveResult> {
    if (this.solveChallengeInFlight) {
      const page = await this.page();
      const title = await page.title().catch(() => "");
      const url = page.url();
      const bodySnippet = snippet(await this.readBody(page));
      return {
        ok: false,
        method: "busy",
        attempts: 0,
        elapsedMs: 0,
        title,
        url,
        bodySnippet,
        widgetState: "unknown",
        tokenPresent: false,
        clicks: [],
        reason: "busy",
        error: "solve_challenge is already running; wait for the current call to finish",
      };
    }

    this.solveChallengeInFlight = true;
    try {
      return await this.solveChallengeLocked(options);
    } finally {
      this.solveChallengeInFlight = false;
    }
  }

  private async solveChallengeLocked(
    options: ChallengeSolveOptions = {},
  ): Promise<ChallengeSolveResult> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 45_000, 3_000), 180_000);
    const maxClicks = Math.min(Math.max(options.maxClicks ?? 12, 1), 30);
    const started = Date.now();
    const clicks: Array<{ x: number; y: number }> = [];
    const page = await this.page();
    /** How many times we entered verifying and exited still uncleared. */
    let stuckVerifyingRounds = 0;
    const maxStuckVerifyingRounds = 2;

    const finish = async (
      partial: Omit<ChallengeSolveResult, "elapsedMs" | "title" | "url" | "bodySnippet" | "widgetState" | "tokenPresent"> & {
        widgetState?: WidgetState;
        tokenPresent?: boolean;
      },
    ): Promise<ChallengeSolveResult> => {
      const observed = await this.observeChallenge(page);
      return {
        ...partial,
        elapsedMs: Date.now() - started,
        title: observed.detection.title,
        url: observed.detection.url,
        bodySnippet: observed.detection.bodySnippet,
        widgetState: partial.widgetState ?? observed.widgetState,
        tokenPresent: partial.tokenPresent ?? observed.tokenPresent,
        widget: partial.widget ?? observed.detection.widget,
      };
    };

    const clearanceInput = (
      observed: Awaited<ReturnType<ChromiumFishBrowser["observeChallenge"]>>,
      kind: ChallengeKind,
    ) => ({
      title: observed.detection.title,
      url: observed.detection.url,
      bodyText: observed.bodyText,
      hadChallenge: true as const,
      kind,
      tokenPresent: observed.tokenPresent,
      widgetState: observed.widgetState,
      hasChallengeFrame: observed.hasChallengeFrame,
    });

    /** Poll without clicking. Returns cleared | still_verifying | ready_for_click. */
    const waitWithoutClicking = async (
      kind: ChallengeKind,
      budgetMs: number,
    ): Promise<"cleared" | "still_verifying" | "ready_for_click"> => {
      const deadline = Math.min(Date.now() + budgetMs, started + timeoutMs);
      let sawVerifying = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(450);
        const observed = await this.observeChallenge(page);
        if (looksCleared(clearanceInput(observed, kind))) {
          // Confirm briefly.
          await page.waitForTimeout(500);
          const confirmed = await this.observeChallenge(page);
          if (looksCleared(clearanceInput(confirmed, kind))) {
            return "cleared";
          }
        }
        if (isVerifyingPhase({
          widgetState: observed.widgetState,
          bodyText: observed.bodyText,
          title: observed.detection.title,
        })) {
          sawVerifying = true;
          continue;
        }
        // Not verifying and not cleared; another click may help.
        if (sawVerifying) return "ready_for_click";
        // Never entered verifying in this wait window.
        if (Date.now() >= deadline) break;
      }
      const end = await this.observeChallenge(page);
      if (looksCleared(clearanceInput(end, kind))) return "cleared";
      if (isVerifyingPhase({
        widgetState: end.widgetState,
        bodyText: end.bodyText,
        title: end.detection.title,
      })) {
        return "still_verifying";
      }
      return sawVerifying ? "still_verifying" : "ready_for_click";
    };

    let observed = await this.observeChallenge(page);
    // Late-mounted challenge frames: wait briefly before concluding already_clear.
    if (!observed.detection.present) {
      const lateDeadline = started + 5_000;
      while (Date.now() < lateDeadline) {
        await page.waitForTimeout(400);
        observed = await this.observeChallenge(page);
        if (observed.detection.present) break;
      }
    }
    if (!observed.detection.present) {
      return finish({
        ok: true,
        method: "already_clear",
        attempts: 0,
        clicks,
        widgetState: observed.widgetState,
        tokenPresent: observed.tokenPresent,
      });
    }

    const kind = observed.kind;
    let widget = observed.detection.widget;

    // Wait for the widget frame to finish mounting.
    while (!widget && Date.now() - started < Math.min(15_000, timeoutMs)) {
      await page.waitForTimeout(350);
      observed = await this.observeChallenge(page);
      if (!observed.detection.present) {
        return finish({
          ok: true,
          method: "already_clear",
          attempts: 0,
          clicks,
          widgetState: observed.widgetState,
          tokenPresent: observed.tokenPresent,
        });
      }
      widget = observed.detection.widget;
    }

    if (!widget) {
      return finish({
        ok: false,
        method: "not_found",
        attempts: 0,
        clicks,
        reason: "not_found",
        error: "Cross-origin challenge control area not found",
      });
    }

    widget = await this.ensureWidgetInViewport(page, widget);

    // Seed the cursor away from (0,0); A/B tests showed origin starts reduce hit rate.
    const seed = initialCursorPos(page.viewportSize());
    await page.mouse.move(seed.x, seed.y);
    this.mousePositions.set(page, seed);
    await page.waitForTimeout(40 + Math.floor(Math.random() * 80));

    // Exterior warm-up path (matches high-success A/B pattern).
    for (const point of warmUpPath(widget)) {
      if (Date.now() - started > timeoutMs) break;
      const viewport = page.viewportSize();
      if (viewport && (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height)) {
        continue;
      }
      await this.moveMouse(page, point.x, point.y, 8 + Math.floor(Math.random() * 4));
      await page.waitForTimeout(50 + Math.floor(Math.random() * 80));
    }

    let attempts = 0;

    const clearedResult = (): Promise<ChallengeSolveResult> =>
      finish({ ok: true, method: "click", attempts, clicks, widget });

    const bumpStuckVerifying = (
      errorMessage: string,
    ): Promise<ChallengeSolveResult> | undefined => {
      stuckVerifyingRounds += 1;
      if (stuckVerifyingRounds < maxStuckVerifyingRounds) return undefined;
      return finish({
        ok: false,
        method: "timeout",
        attempts,
        clicks,
        widget,
        reason: "stuck_verifying",
        error: errorMessage,
      });
    };

    while (Date.now() - started < timeoutMs && attempts < maxClicks) {
      // If already verifying, do NOT click; only wait.
      observed = await this.observeChallenge(page);
      if (isVerifyingPhase({
        widgetState: observed.widgetState,
        bodyText: observed.bodyText,
        title: observed.detection.title,
      })) {
        const waitResult = await waitWithoutClicking(kind, 15_000);
        if (waitResult === "cleared") return clearedResult();
        if (waitResult === "still_verifying") {
          const stuckResult = bumpStuckVerifying(
            "The page remained in the Verifying state too long; stopped clicking",
          );
          if (stuckResult) return stuckResult;
        }
      }

      widget = await this.ensureWidgetInViewport(
        page,
        (await this.findTurnstileWidget(page)) ?? widget,
      );
      // Prefer the left-checkbox primary target first (same as successful A/B: box.x+28).
      const primary = {
        x: widget.x + Math.min(36, Math.max(22, widget.width * 0.1)),
        y: widget.y + widget.height / 2,
      };
      const queue = attempts === 0 ? [primary, ...checkboxClickCandidates(widget)] : checkboxClickCandidates(widget);
      const target = queue[attempts % queue.length] ?? primary;
      const x = target.x + (Math.random() - 0.5) * 3;
      const y = target.y + (Math.random() - 0.5) * 2;
      attempts += 1;
      clicks.push({ x, y });
      await this.moveMouse(page, x, y, 14 + Math.floor(Math.random() * 6));
      await page.waitForTimeout(80 + Math.floor(Math.random() * 100));
      await page.mouse.down();
      await page.waitForTimeout(45 + Math.floor(Math.random() * 60));
      await page.mouse.up();

      // After each click: long no-click wait (verifying-aware).
      // The first click gets a longer window; successful manual paths clear in about 1-3s.
      const waitBudget = attempts === 1 ? 18_000 : 12_000;
      const waitResult = await waitWithoutClicking(kind, waitBudget);
      if (waitResult === "cleared") return clearedResult();
      if (waitResult === "still_verifying") {
        const stuckResult = bumpStuckVerifying(
          "The page remained in the Verifying state too long after a click; stopped clicking",
        );
        if (stuckResult) return stuckResult;
      }
    }

    observed = await this.observeChallenge(page);
    const cleared = looksCleared(clearanceInput(observed, kind));
    if (cleared) {
      return finish({
        ok: true,
        method: "click",
        attempts,
        clicks,
        widget,
        widgetState: observed.widgetState,
        tokenPresent: observed.tokenPresent,
      });
    }
    const stuck = isVerifyingPhase({
      widgetState: observed.widgetState,
      bodyText: observed.bodyText,
      title: observed.detection.title,
    });
    return finish({
      ok: false,
      method: "timeout",
      attempts,
      clicks,
      widget,
      widgetState: observed.widgetState,
      tokenPresent: observed.tokenPresent,
      reason: stuck ? "stuck_verifying" : "timeout",
      error: stuck
        ? "The page remained in the Verifying state too long; stopped clicking"
        : "Could not confirm challenge clearance before the timeout",
    });
  }

  async typeText(
    target: string,
    text: string,
    clear: boolean,
    submit: boolean,
    frameId?: string,
    options?: ActionOptions,
  ): Promise<ActionResult> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    const baseline = this.actionBaseline(page);
    await this.moveTo(page, handle);
    await page.mouse.click(
      this.mousePositions.get(page)?.x ?? 0,
      this.mousePositions.get(page)?.y ?? 0,
    );
    if (clear) {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
    }
    await page.keyboard.type(text, { delay: 45 });
    if (submit) await page.keyboard.press("Enter");
    return this.actionResult(page, baseline, options);
  }

  async pressKey(key: string, options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const baseline = this.actionBaseline(page);
    await page.keyboard.press(key);
    return this.actionResult(page, baseline, options);
  }

  async scroll(deltaX: number, deltaY: number, options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const baseline = this.actionBaseline(page);
    await page.mouse.wheel(deltaX, deltaY);
    return this.actionResult(page, baseline, options);
  }

  async waitFor(options: WaitForOptions, actionOptions?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    const baseline = this.actionBaseline(page);
    await this.runWaitCondition(page, options);
    return this.actionResult(page, baseline, actionOptions);
  }

  private async runWaitCondition(page: Page, options: WaitForOptions): Promise<void> {
    const condition = options.condition;

    if (condition.kind === "element") {
      const state = condition.state ?? "visible";
      if (!/^e\d+$/.test(condition.target)) {
        const frame = this.resolveFrame(page, condition.frameId);
        await frame.locator(condition.target).first().waitFor({ state, timeout: options.timeoutMs });
        return;
      }
      const handle = this.refs.get(page)?.get(condition.target);
      if (!handle) throw this.unknownRefError(page, condition.target);
      const ownerFrame = await handle.ownerFrame();
      if (!ownerFrame) throw new Error(`Target ${condition.target} is no longer attached to a frame`);
      if (condition.frameId && ownerFrame !== this.resolveFrame(page, condition.frameId)) {
        throw new Error(`Target ${condition.target} does not belong to frame ${condition.frameId}`);
      }
      await ownerFrame.waitForFunction(
        ({ element, desired }) => {
          const connected = element.isConnected;
          const rect = element.getBoundingClientRect();
          const visible = connected && rect.width > 0 && rect.height > 0;
          if (desired === "attached") return connected;
          if (desired === "detached") return !connected;
          if (desired === "visible") return visible;
          return !visible;
        },
        { element: handle, desired: state },
        { timeout: options.timeoutMs },
      );
      return;
    }

    if (condition.kind === "text") {
      const frame = this.resolveFrame(page, condition.frameId);
      const visibleMatches = frame.getByText(condition.text, { exact: false }).filter({ visible: true });
      await visibleMatches.first().waitFor({
        state: (condition.state ?? "visible") === "visible" ? "attached" : "detached",
        timeout: options.timeoutMs,
      });
      return;
    }

    if (condition.kind === "url") {
      await page.waitForURL(condition.url, {
        timeout: options.timeoutMs,
        waitUntil: "domcontentloaded",
      });
      return;
    }

    if (condition.kind === "load") {
      await page.waitForLoadState(condition.state, { timeout: options.timeoutMs });
      return;
    }

    await page.waitForTimeout(condition.timeMs);
  }

  async evaluate(expression: string): Promise<string> {
    const value = await (await this.page()).evaluate((source) => {
      return (0, eval)(source) as unknown;
    }, expression);
    return jsonValue(value);
  }

  private async targetId(page: Page, session: CDPSession): Promise<string> {
    const result = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    const targetId = result.targetInfo?.targetId;
    if (!targetId) throw new Error("Unable to determine the current page's CDP targetId");
    return targetId;
  }

  async runTask(task: string, rawUrl: string | undefined, maxSteps: number): Promise<NativeTaskResult> {
    if (!this.config.allowNativeAgent) throw new Error("Native agent tool is not enabled");
    if (rawUrl) await this.navigate(rawUrl);
    const page = await this.page();
    const session = await page.context().newCDPSession(page);
    try {
      const targetId = await this.targetId(page, session);
      const sendCustomCommand = session.send.bind(session) as unknown as (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = await sendCustomCommand("Browser.agentRunTask", {
        targetId,
        goal: task,
        maxSteps,
      }) as { success?: boolean; finalText?: string; stepsJson?: string };
      let steps = 0;
      try {
        const parsed = JSON.parse(result.stepsJson ?? "[]");
        if (Array.isArray(parsed)) steps = parsed.length;
      } catch {
        steps = 0;
      }
      return {
        success: Boolean(result.success),
        finalText: result.finalText ?? "",
        steps,
      };
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    this.currentPage = undefined;
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}
