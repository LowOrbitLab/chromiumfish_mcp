import { existsSync } from "node:fs";
import { buildArgs, ChromiumFish } from "chromiumfish";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  Frame,
  Page,
} from "playwright-core";
import { chromium } from "playwright-core";
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
  type ClickChallengeResult,
  type WidgetBox,
  type WidgetState,
} from "./turnstile.js";

export type { ChallengeDetection, ChallengeKind, ClickChallengeResult, WidgetBox, WidgetState };

export interface PageSummary {
  pageId: string;
  current: boolean;
  title: string;
  url: string;
}

export interface NavigationResult {
  title: string;
  url: string;
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

export interface MouseClickResult {
  x: number;
  y: number;
  title: string;
  url: string;
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
  newPage(url?: string): Promise<PageSummary>;
  selectPage(pageId: string): Promise<PageSummary>;
  closePage(pageId?: string): Promise<PageListResult>;
  navigate(url: string): Promise<NavigationResult>;
  goBack(): Promise<NavigationResult>;
  goForward(): Promise<NavigationResult>;
  reload(): Promise<NavigationResult>;
  snapshot(options?: SnapshotOptions): Promise<string>;
  getText(options?: GetTextOptions): Promise<string>;
  screenshot(fullPage: boolean): Promise<Buffer>;
  click(target: string, frameId?: string): Promise<void>;
  hover(target: string, frameId?: string): Promise<void>;
  selectOption(
    target: string,
    values: string[],
    matchBy: SelectOptionMatch,
    frameId?: string,
  ): Promise<string[]>;
  setChecked(target: string, checked: boolean, frameId?: string): Promise<boolean>;
  mouseClick(x: number, y: number): Promise<MouseClickResult>;
  listFrames(options?: { includeBox?: boolean }): Promise<FrameSummary[]>;
  findChallenge(): Promise<ChallengeDetection>;
  clickChallenge(options?: { timeoutMs?: number; maxClicks?: number }): Promise<ClickChallengeResult>;
  typeText(target: string, text: string, clear: boolean, submit: boolean, frameId?: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  waitFor(options: WaitForOptions): Promise<void>;
  evalJs(expression: string): Promise<string>;
  runTask(task: string, url: string | undefined, maxSteps: number): Promise<NativeTaskResult>;
  close(): Promise<void>;
}

type InteractiveHandle = ElementHandle<HTMLElement | SVGElement>;

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
const TEXT_LOCATOR_TIMEOUT_MS = 5_000;
const SNAPSHOT_TRUNCATION_MARKER = "narrow scope or adjust maxElements/maxChars";

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const suffix = `\n\n[Content truncated; ${value.length} characters total]`;
  const contentLength = Math.max(0, max - suffix.length);
  return `${value.slice(0, contentLength)}${suffix.slice(0, max - contentLength)}`;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
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

export class ChromiumFishBrowser implements BrowserApi {
  private browser?: Browser;
  private context?: BrowserContext;
  private currentPage?: Page;
  private readonly pageIds = new WeakMap<Page, string>();
  private nextPageId = 1;
  private readonly frameIds = new WeakMap<Frame, string>();
  private nextFrameId = 1;
  private readonly refs = new WeakMap<Page, Map<string, InteractiveHandle>>();
  private readonly mousePositions = new WeakMap<Page, { x: number; y: number }>();
  /** Prevent concurrent solve_challenge runs from fighting over the same mouse. */
  private clickChallengeInFlight = false;

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

  async newPage(rawUrl?: string): Promise<PageSummary> {
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

  async navigate(rawUrl: string): Promise<NavigationResult> {
    const url = assertNavigationUrl(rawUrl, this.config.allowedHosts);
    const page = await this.page();
    await this.clearRefs(page);
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    return { title: await page.title(), url: page.url() };
  }

  async goBack(): Promise<NavigationResult> {
    const page = await this.page();
    await this.clearRefs(page);
    await page.goBack({ waitUntil: "domcontentloaded" });
    return { title: await page.title(), url: page.url() };
  }

  async goForward(): Promise<NavigationResult> {
    const page = await this.page();
    await this.clearRefs(page);
    await page.goForward({ waitUntil: "domcontentloaded" });
    return { title: await page.title(), url: page.url() };
  }

  async reload(): Promise<NavigationResult> {
    const page = await this.page();
    await this.clearRefs(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    return { title: await page.title(), url: page.url() };
  }

  private async clearRefs(page: Page): Promise<void> {
    const refs = this.refs.get(page);
    this.refs.delete(page);
    if (!refs) return;
    await Promise.all([...refs.values()].map((handle) => handle.dispose().catch(() => undefined)));
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
    const handles = await locator.elementHandles() as InteractiveHandle[];
    const maxElements = clampInteger(
      options.maxElements,
      DEFAULT_SNAPSHOT_ELEMENTS,
      1,
      MAX_SNAPSHOT_ELEMENTS,
    );
    const requestedMaxChars = clampInteger(
      options.maxChars,
      DEFAULT_SNAPSHOT_CHARS,
      MIN_SNAPSHOT_CHARS,
      this.config.maxTextChars,
    );
    const maxChars = Math.min(requestedMaxChars, this.config.maxTextChars);
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
              role: (html.getAttribute("role") || html.tagName.toLowerCase()).slice(0, 40),
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

          const ref = `e${refs.size + 1}`;
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
          let line = `[${ref}] ${info.role} ${JSON.stringify(info.label)}${suffix ? ` ${suffix}` : ""}`;
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
    const text = options.selector
      ? await locator.innerText({ timeout: TEXT_LOCATOR_TIMEOUT_MS })
      : await locator.innerText({ timeout: TEXT_LOCATOR_TIMEOUT_MS }).catch(() => "");
    const defaultMax = Math.min(DEFAULT_SNAPSHOT_CHARS, this.config.maxTextChars);
    const maxChars = Math.min(
      clampInteger(options.maxChars, defaultMax, 100, this.config.maxTextChars),
      this.config.maxTextChars,
    );
    return clip(text, maxChars);
  }

  async screenshot(fullPage: boolean): Promise<Buffer> {
    const page = await this.page();
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

  private async resolveTarget(page: Page, target: string, frameId?: string): Promise<InteractiveHandle> {
    const ref = this.refs.get(page)?.get(target);
    if (ref && frameId) {
      const requestedFrame = this.resolveFrame(page, frameId);
      const ownerFrame = await ref.ownerFrame();
      if (ownerFrame !== requestedFrame) {
        throw new Error(`Target ${target} does not belong to frame ${frameId}`);
      }
    }
    if (!ref && /^e\d+$/.test(target)) {
      throw new Error(`Unknown element reference ${target}; call snapshot again`);
    }
    const handle = ref ?? await this.resolveFrame(page, frameId).locator(target).first().elementHandle();
    if (!handle) throw new Error(`Target ${target} not found; call snapshot again after the page changes`);
    const connected = await handle.evaluate((element) => element.isConnected).catch(() => false);
    if (!connected) throw new Error(`Target ${target} is stale; call snapshot again`);
    return handle as InteractiveHandle;
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
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) throw new Error("Target is not currently clickable");
    const destination = {
      x: box.x + box.width * (0.35 + Math.random() * 0.3),
      y: box.y + box.height * (0.35 + Math.random() * 0.3),
    };
    await this.moveMouse(page, destination.x, destination.y, 12);
  }

  private async clickHandle(page: Page, handle: InteractiveHandle): Promise<void> {
    await this.moveTo(page, handle);
    await page.mouse.down();
    await page.waitForTimeout(45 + Math.floor(Math.random() * 70));
    await page.mouse.up();
  }

  async click(target: string, frameId?: string): Promise<void> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    await this.clickHandle(page, handle);
  }

  async hover(target: string, frameId?: string): Promise<void> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    await this.moveTo(page, handle);
  }

  async selectOption(
    target: string,
    values: string[],
    matchBy: SelectOptionMatch,
    frameId?: string,
  ): Promise<string[]> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    const options = values.map((value) => matchBy === "label" ? { label: value } : { value });
    return handle.selectOption(options);
  }

  async setChecked(target: string, checked: boolean, frameId?: string): Promise<boolean> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
    const kind = await handle.evaluate((element) => {
      if (element instanceof HTMLInputElement) return element.type.toLowerCase();
      return element.getAttribute("role")?.toLowerCase() ?? "";
    });
    if (kind === "radio" && !checked) {
      throw new Error(`Radio target ${target} cannot be unchecked directly; select another radio option instead`);
    }
    let actual = await handle.isChecked();
    if (actual !== checked) {
      await this.clickHandle(page, handle);
      actual = await handle.isChecked();
    }
    if (actual !== checked) {
      throw new Error(`Target ${target} did not reach the requested checked state`);
    }
    return actual;
  }

  async mouseClick(x: number, y: number): Promise<MouseClickResult> {
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
    await this.moveMouse(page, x, y, 14);
    await page.waitForTimeout(40 + Math.floor(Math.random() * 90));
    await page.mouse.down();
    await page.waitForTimeout(45 + Math.floor(Math.random() * 70));
    await page.mouse.up();
    return {
      x,
      y,
      title: await page.title().catch(() => ""),
      url: page.url(),
    };
  }

  private async frameBox(
    frame: Frame,
    options: { scroll?: boolean } = {},
  ): Promise<WidgetBox | undefined> {
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

  private async readTurnstileToken(page: Page): Promise<string> {
    // Avoid probing challenge-related inputs while still on a CF gate page.
    // A/B: evaluateAll on cf-turnstile-response / cf-chl-widget* before click => 0/3 pass;
    // same click path without the probe => 3/3 pass.
    const title = await page.title().catch(() => "");
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
    const token = await this.readTurnstileToken(page);
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

  async clickChallenge(options: { timeoutMs?: number; maxClicks?: number } = {}): Promise<ClickChallengeResult> {
    if (this.clickChallengeInFlight) {
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

    this.clickChallengeInFlight = true;
    try {
      return await this.clickChallengeLocked(options);
    } finally {
      this.clickChallengeInFlight = false;
    }
  }

  private async clickChallengeLocked(
    options: { timeoutMs?: number; maxClicks?: number } = {},
  ): Promise<ClickChallengeResult> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 45_000, 3_000), 180_000);
    const maxClicks = Math.min(Math.max(options.maxClicks ?? 12, 1), 30);
    const started = Date.now();
    const clicks: Array<{ x: number; y: number }> = [];
    const page = await this.page();
    /** How many times we entered verifying and exited still uncleared. */
    let stuckVerifyingRounds = 0;
    const maxStuckVerifyingRounds = 2;

    const finish = async (
      partial: Omit<ClickChallengeResult, "elapsedMs" | "title" | "url" | "bodySnippet" | "widgetState" | "tokenPresent"> & {
        widgetState?: WidgetState;
        tokenPresent?: boolean;
      },
    ): Promise<ClickChallengeResult> => {
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

    const clearedResult = (): Promise<ClickChallengeResult> =>
      finish({ ok: true, method: "click", attempts, clicks, widget });

    const bumpStuckVerifying = (
      errorMessage: string,
    ): Promise<ClickChallengeResult> | undefined => {
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
  ): Promise<void> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target, frameId);
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
  }

  async pressKey(key: string): Promise<void> {
    await (await this.page()).keyboard.press(key);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await (await this.page()).mouse.wheel(deltaX, deltaY);
  }

  async waitFor(options: WaitForOptions): Promise<void> {
    const page = await this.page();
    const condition = options.condition;

    if (condition.kind === "element") {
      const state = condition.state ?? "visible";
      if (!/^e\d+$/.test(condition.target)) {
        const frame = this.resolveFrame(page, condition.frameId);
        await frame.locator(condition.target).first().waitFor({ state, timeout: options.timeoutMs });
        return;
      }
      const handle = this.refs.get(page)?.get(condition.target);
      if (!handle) throw new Error(`Unknown element reference ${condition.target}; call snapshot again`);
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

  async evalJs(expression: string): Promise<string> {
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
