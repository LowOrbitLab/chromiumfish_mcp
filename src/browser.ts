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
  isCloudflareFrameUrl,
  isVerifyingPhase,
  looksCleared,
  snippet,
  warmUpPath,
  type ChallengeDetection,
  type ChallengeKind,
  type SolveTurnstileResult,
  type WidgetBox,
  type WidgetState,
} from "./turnstile.js";

export type { ChallengeDetection, ChallengeKind, SolveTurnstileResult, WidgetBox, WidgetState };

export interface PageSummary {
  id: string;
  current: boolean;
  title: string;
  url: string;
}

export interface NavigationResult {
  title: string;
  url: string;
}

export interface BrowserStatus {
  running: boolean;
  pages: number;
  currentPageId?: string;
}

export interface NativeTaskResult {
  success: boolean;
  finalText: string;
  steps: number;
}

export interface FrameSummary {
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

export interface BrowserApi {
  status(): Promise<BrowserStatus>;
  listPages(): Promise<PageSummary[]>;
  newPage(url?: string): Promise<PageSummary>;
  selectPage(pageId: string): Promise<PageSummary>;
  closePage(pageId?: string): Promise<void>;
  navigate(url: string): Promise<NavigationResult>;
  goBack(): Promise<NavigationResult>;
  snapshot(): Promise<string>;
  getText(): Promise<string>;
  screenshot(fullPage: boolean): Promise<Buffer>;
  click(target: string): Promise<void>;
  mouseClick(x: number, y: number): Promise<MouseClickResult>;
  listFrames(options?: { includeBox?: boolean }): Promise<FrameSummary[]>;
  detectChallenge(): Promise<ChallengeDetection>;
  solveTurnstile(options?: { timeoutMs?: number; maxClicks?: number }): Promise<SolveTurnstileResult>;
  typeText(target: string, text: string, clear: boolean, submit: boolean): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  waitFor(target: string, state: "attached" | "detached" | "visible" | "hidden", timeoutMs: number): Promise<void>;
  evalJs(expression: string): Promise<unknown>;
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

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[内容已截断，共 ${value.length} 个字符]`;
}

function jsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value, null, 2);
  return encoded ?? String(value);
}

export function assertNavigationUrl(rawUrl: string, allowedHosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("URL 无效，必须包含 http:// 或 https://");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("只允许导航到 HTTP 或 HTTPS URL");
  }
  if (url.username || url.password) {
    throw new Error("导航 URL 不允许包含用户名或密码");
  }
  if (allowedHosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const allowed = allowedHosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    if (!allowed) throw new Error(`目标主机 ${host} 不在 --allowed-host 白名单中`);
  }
  return url;
}

export class ChromiumFishBrowser implements BrowserApi {
  private browser?: Browser;
  private context?: BrowserContext;
  private currentPage?: Page;
  private readonly pageIds = new WeakMap<Page, string>();
  private nextPageId = 1;
  private readonly refs = new WeakMap<Page, Map<string, InteractiveHandle>>();
  private readonly mousePositions = new WeakMap<Page, { x: number; y: number }>();
  /** Prevent concurrent solve_turnstile runs from fighting over the same mouse. */
  private solveInFlight = false;

  constructor(private readonly config: ServerConfig) {}

  async status(): Promise<BrowserStatus> {
    const pages = this.context?.pages().filter((page) => !page.isClosed()) ?? [];
    return {
      running: Boolean(this.browser?.isConnected()),
      pages: pages.length,
      ...(this.currentPage && !this.currentPage.isClosed()
        ? { currentPageId: this.pageId(this.currentPage) }
        : {}),
    };
  }

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
        throw new Error(`ChromiumFish 可执行文件不存在：${this.config.chromePath}`);
      }
      if (this.config.timezone === "auto") {
        throw new Error("--chrome-path 暂不支持 --timezone auto，请传入明确的 IANA 时区");
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
    this.currentPage = await this.context.newPage();
    this.trackPage(this.currentPage);
    return this.context;
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

  private async pageSummary(page: Page): Promise<PageSummary> {
    let title = "";
    try {
      title = await page.title();
    } catch {
      title = "";
    }
    return {
      id: this.pageId(page),
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

  async listPages(): Promise<PageSummary[]> {
    const context = await this.ensureContext();
    return Promise.all(context.pages().filter((page) => !page.isClosed()).map((page) => this.pageSummary(page)));
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
    const context = await this.ensureContext();
    const page = context.pages().find((candidate) => this.pageId(candidate) === pageId && !candidate.isClosed());
    if (!page) throw new Error(`未找到页面 ${pageId}`);
    this.currentPage = page;
    await page.bringToFront();
    return this.pageSummary(page);
  }

  async closePage(pageId?: string): Promise<void> {
    const page = pageId
      ? (await this.ensureContext()).pages().find((candidate) => this.pageId(candidate) === pageId)
      : await this.page();
    if (!page || page.isClosed()) throw new Error(`未找到页面 ${pageId ?? "current"}`);
    await this.clearRefs(page);
    await page.close();
    if (this.currentPage === page) this.currentPage = undefined;
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

  private async clearRefs(page: Page): Promise<void> {
    const refs = this.refs.get(page);
    this.refs.delete(page);
    if (!refs) return;
    await Promise.all([...refs.values()].map((handle) => handle.dispose().catch(() => undefined)));
  }

  async snapshot(): Promise<string> {
    const page = await this.page();
    await this.clearRefs(page);
    const handles = await page.locator(INTERACTIVE_SELECTOR).elementHandles();
    const refs = new Map<string, InteractiveHandle>();
    const lines: string[] = [];

    for (const handle of handles.slice(0, 250) as InteractiveHandle[]) {
      if (!(await handle.isVisible().catch(() => false))) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      const info = await handle.evaluate((element) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const label = html.getAttribute("aria-label")
          || input.labels?.[0]?.textContent
          || input.value
          || input.placeholder
          || html.innerText
          || html.getAttribute("title")
          || "";
        return {
          role: html.getAttribute("role") || html.tagName.toLowerCase(),
          label: label.trim().replace(/\s+/g, " ").slice(0, 120),
          href: element instanceof HTMLAnchorElement ? element.href : "",
          disabled: "disabled" in html && Boolean((html as HTMLButtonElement).disabled),
        };
      }).catch(() => null);
      if (!info) {
        await handle.dispose().catch(() => undefined);
        continue;
      }
      const ref = `e${refs.size + 1}`;
      refs.set(ref, handle);
      const suffix = [info.disabled ? "disabled" : "", info.href ? `-> ${info.href}` : ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`[${ref}] ${info.role} "${info.label}"${suffix ? ` ${suffix}` : ""}`);
    }
    this.refs.set(page, refs);
    return lines.length > 0 ? lines.join("\n") : "(没有可见的交互元素)";
  }

  async getText(): Promise<string> {
    const text = await (await this.page()).locator("body").innerText().catch(() => "");
    return clip(text, this.config.maxTextChars);
  }

  async screenshot(fullPage: boolean): Promise<Buffer> {
    return (await this.page()).screenshot({ type: "png", fullPage });
  }

  private async resolveTarget(page: Page, target: string): Promise<InteractiveHandle> {
    const ref = this.refs.get(page)?.get(target);
    const handle = ref ?? await page.locator(target).first().elementHandle();
    if (!handle) throw new Error(`未找到目标 ${target}；页面变化后请重新调用 snapshot`);
    const connected = await handle.evaluate((element) => element.isConnected).catch(() => false);
    if (!connected) throw new Error(`目标 ${target} 已失效；请重新调用 snapshot`);
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
    if (!box) throw new Error("目标当前不可点击");
    const destination = {
      x: box.x + box.width * (0.35 + Math.random() * 0.3),
      y: box.y + box.height * (0.35 + Math.random() * 0.3),
    };
    await this.moveMouse(page, destination.x, destination.y, 12);
  }

  async click(target: string): Promise<void> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target);
    await this.moveTo(page, handle);
    await page.mouse.down();
    await page.waitForTimeout(45 + Math.floor(Math.random() * 70));
    await page.mouse.up();
  }

  async mouseClick(x: number, y: number): Promise<MouseClickResult> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("mouse_click 需要有限数值坐标 x/y");
    }
    const page = await this.page();
    const viewport = page.viewportSize();
    if (viewport) {
      if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) {
        throw new Error(
          `坐标 (${x}, ${y}) 超出视口 ${viewport.width}x${viewport.height}`,
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
    const includeBox = options.includeBox !== false;
    const page = await this.page();
    const frames = page.frames();
    if (!includeBox) {
      return frames.map((frame) => ({ url: frame.url(), name: frame.name() }));
    }
    // Bounding boxes only — do not scroll frames during listing (avoids layout thrash).
    const boxes = await Promise.all(frames.map(async (frame) => ({
      frame,
      box: await this.frameBox(frame, { scroll: false }),
    })));
    return boxes.map(({ frame, box }) => ({
      url: frame.url(),
      name: frame.name(),
      ...(box ? { box: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}),
    }));
  }

  private async readTurnstileToken(page: Page): Promise<string> {
    const selectors = [
      "input[name=\"cf-turnstile-response\"]",
      "textarea[name=\"cf-turnstile-response\"]",
      "input[name=\"cf-turnstile-response-field\"]",
      "[name=\"cf-turnstile-response\"]",
      "input[id^=\"cf-chl-widget\"][name*=\"response\"]",
    ];
    for (const selector of selectors) {
      const values = await page.locator(selector).evaluateAll((nodes) =>
        nodes
          .map((node) => {
            if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
              return node.value || "";
            }
            return (node as HTMLElement).textContent || "";
          })
          .filter((value) => value.trim().length > 0),
      ).catch(() => [] as string[]);
      if (values[0]) return values[0];
    }
    // Hidden fields inside same-origin wrappers
    const anyToken = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("input, textarea"));
      for (const node of nodes) {
        const el = node as HTMLInputElement | HTMLTextAreaElement;
        const name = (el.name || el.id || "").toLowerCase();
        if (name.includes("turnstile") && name.includes("response") && el.value?.trim()) {
          return el.value.trim();
        }
      }
      return "";
    }).catch(() => "");
    return anyToken;
  }

  private async readChallengeFrameText(page: Page): Promise<string> {
    const parts: string[] = [];
    for (const frame of page.frames()) {
      if (!isCloudflareFrameUrl(frame.url())) continue;
      const text = await frame.locator("body").innerText({ timeout: 800 }).catch(() => "");
      if (text.trim()) parts.push(text.trim());
    }
    return parts.join("\n");
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
  }> {
    const title = await page.title().catch(() => "");
    const url = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const frameUrls = page.frames().map((frame) => frame.url());
    const hasChallengeFrame = frameUrls.some((frameUrl) => isCloudflareFrameUrl(frameUrl));
    const token = await this.readTurnstileToken(page);
    const tokenPresent = token.length > 10;
    const frameText = hasChallengeFrame ? await this.readChallengeFrameText(page) : "";
    const widgetState = inferWidgetState({
      tokenPresent,
      hasChallengeFrame,
      frameText,
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

  async detectChallenge(): Promise<ChallengeDetection> {
    const page = await this.page();
    return (await this.observeChallenge(page)).detection;
  }

  async solveTurnstile(options: { timeoutMs?: number; maxClicks?: number } = {}): Promise<SolveTurnstileResult> {
    if (this.solveInFlight) {
      const page = await this.page();
      const title = await page.title().catch(() => "");
      const url = page.url();
      const bodySnippet = snippet(await page.locator("body").innerText().catch(() => ""));
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
        error: "solve_turnstile 已在执行中，请等待当前调用结束",
      };
    }

    this.solveInFlight = true;
    try {
      return await this.solveTurnstileLocked(options);
    } finally {
      this.solveInFlight = false;
    }
  }

  private async solveTurnstileLocked(
    options: { timeoutMs?: number; maxClicks?: number } = {},
  ): Promise<SolveTurnstileResult> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 45_000, 3_000), 180_000);
    const maxClicks = Math.min(Math.max(options.maxClicks ?? 12, 1), 30);
    const started = Date.now();
    const clicks: Array<{ x: number; y: number }> = [];
    const page = await this.page();
    /** How many times we entered verifying and exited still uncleared. */
    let stuckVerifyingRounds = 0;
    const maxStuckVerifyingRounds = 2;

    const finish = async (
      partial: Omit<SolveTurnstileResult, "elapsedMs" | "title" | "url" | "bodySnippet" | "widgetState" | "tokenPresent"> & {
        widgetState?: WidgetState;
        tokenPresent?: boolean;
      },
    ): Promise<SolveTurnstileResult> => {
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
      bodyText: string,
      kind: ChallengeKind,
    ) => ({
      title: observed.detection.title,
      url: observed.detection.url,
      bodyText,
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
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (looksCleared(clearanceInput(observed, bodyText, kind))) {
          // Confirm briefly.
          await page.waitForTimeout(500);
          const confirmed = await this.observeChallenge(page);
          const confirmedBody = await page.locator("body").innerText().catch(() => "");
          if (looksCleared(clearanceInput(confirmed, confirmedBody, kind))) {
            return "cleared";
          }
        }
        if (isVerifyingPhase({
          widgetState: observed.widgetState,
          bodyText,
          title: observed.detection.title,
        })) {
          sawVerifying = true;
          continue;
        }
        // Not verifying and not cleared → another click may help.
        if (sawVerifying) return "ready_for_click";
        // Never entered verifying in this wait window.
        if (Date.now() >= deadline) break;
      }
      const end = await this.observeChallenge(page);
      const endBody = await page.locator("body").innerText().catch(() => "");
      if (looksCleared(clearanceInput(end, endBody, kind))) return "cleared";
      if (isVerifyingPhase({
        widgetState: end.widgetState,
        bodyText: endBody,
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
        error: "未找到跨域 challenge 控件区域",
      });
    }

    widget = await this.ensureWidgetInViewport(page, widget);

    // Human-ish warm-up path near the widget.
    for (const point of warmUpPath(widget)) {
      if (Date.now() - started > timeoutMs) break;
      const viewport = page.viewportSize();
      if (viewport && (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height)) {
        continue;
      }
      await this.moveMouse(page, point.x, point.y, 8 + Math.floor(Math.random() * 6));
      await page.waitForTimeout(60 + Math.floor(Math.random() * 120));
    }

    let attempts = 0;

    while (Date.now() - started < timeoutMs && attempts < maxClicks) {
      // If already verifying, do NOT click — only wait.
      observed = await this.observeChallenge(page);
      let bodyText = await page.locator("body").innerText().catch(() => "");
      if (isVerifyingPhase({
        widgetState: observed.widgetState,
        bodyText,
        title: observed.detection.title,
      })) {
        const waitResult = await waitWithoutClicking(kind, 15_000);
        if (waitResult === "cleared") {
          observed = await this.observeChallenge(page);
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
        if (waitResult === "still_verifying") {
          stuckVerifyingRounds += 1;
          if (stuckVerifyingRounds >= maxStuckVerifyingRounds) {
            return finish({
              ok: false,
              method: "timeout",
              attempts,
              clicks,
              widget,
              reason: "stuck_verifying",
              error: "页面停留在 Verifying 状态过久，已停止继续点击",
            });
          }
          // One more careful click after a stuck verify round.
        }
        // ready_for_click → fall through to click
      }

      widget = await this.ensureWidgetInViewport(
        page,
        (await this.findTurnstileWidget(page)) ?? widget,
      );
      const queue = checkboxClickCandidates(widget);
      const target = queue[attempts % queue.length] ?? {
        x: widget.x + Math.min(40, widget.width * 0.15),
        y: widget.y + widget.height / 2,
      };
      const x = target.x + (Math.random() - 0.5) * 4;
      const y = target.y + (Math.random() - 0.5) * 3;
      attempts += 1;
      clicks.push({ x, y });
      await this.moveMouse(page, x, y, 16);
      await page.waitForTimeout(100 + Math.floor(Math.random() * 180));
      await page.mouse.down();
      await page.waitForTimeout(50 + Math.floor(Math.random() * 80));
      await page.mouse.up();

      // After each click: long no-click wait (verifying-aware).
      const waitResult = await waitWithoutClicking(kind, 14_000);
      if (waitResult === "cleared") {
        observed = await this.observeChallenge(page);
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
      if (waitResult === "still_verifying") {
        stuckVerifyingRounds += 1;
        if (stuckVerifyingRounds >= maxStuckVerifyingRounds) {
          return finish({
            ok: false,
            method: "timeout",
            attempts,
            clicks,
            widget,
            reason: "stuck_verifying",
            error: "点击后页面停留在 Verifying 状态过久，已停止继续点击",
          });
        }
      }
    }

    observed = await this.observeChallenge(page);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const cleared = looksCleared(clearanceInput(observed, bodyText, kind));
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
      bodyText,
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
        ? "页面停留在 Verifying 状态过久，已停止继续点击"
        : "在超时时间内未能确认 challenge 已清除",
    });
  }

  async typeText(target: string, text: string, clear: boolean, submit: boolean): Promise<void> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target);
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

  async waitFor(
    target: string,
    state: "attached" | "detached" | "visible" | "hidden",
    timeoutMs: number,
  ): Promise<void> {
    const page = await this.page();
    if (/^e\d+$/.test(target)) {
      const handle = this.refs.get(page)?.get(target);
      if (!handle) throw new Error(`未知元素引用 ${target}；请重新调用 snapshot`);
      await page.waitForFunction(
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
        { timeout: timeoutMs },
      );
      return;
    }
    await page.locator(target).first().waitFor({ state, timeout: timeoutMs });
  }

  async evalJs(expression: string): Promise<unknown> {
    const value = await (await this.page()).evaluate((source) => {
      return (0, eval)(source) as unknown;
    }, expression);
    return jsonValue(value);
  }

  private async targetId(page: Page, session: CDPSession): Promise<string> {
    const result = await session.send("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    const targetId = result.targetInfo?.targetId;
    if (!targetId) throw new Error("无法确定当前页面的 CDP targetId");
    return targetId;
  }

  async runTask(task: string, rawUrl: string | undefined, maxSteps: number): Promise<NativeTaskResult> {
    if (!this.config.allowNativeAgent) throw new Error("原生代理工具未启用");
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
