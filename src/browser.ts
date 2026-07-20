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
  isCloudflareFrameUrl,
  looksCleared,
  snippet,
  warmUpPath,
  type ChallengeDetection,
  type SolveTurnstileResult,
  type WidgetBox,
} from "./turnstile.js";

export type { ChallengeDetection, SolveTurnstileResult, WidgetBox };

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
  listFrames(): Promise<FrameSummary[]>;
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

  private async moveTo(page: Page, handle: InteractiveHandle): Promise<void> {
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    if (!box) throw new Error("目标当前不可点击");
    const destination = {
      x: box.x + box.width * (0.35 + Math.random() * 0.3),
      y: box.y + box.height * (0.35 + Math.random() * 0.3),
    };
    const start = this.mousePositions.get(page) ?? { x: 0, y: 0 };
    const control = {
      x: (start.x + destination.x) / 2 + (Math.random() - 0.5) * 80,
      y: (start.y + destination.y) / 2 + (Math.random() - 0.5) * 80,
    };
    const steps = 12;
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const inverse = 1 - t;
      await page.mouse.move(
        inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * destination.x,
        inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * destination.y,
      );
    }
    this.mousePositions.set(page, destination);
  }

  async click(target: string): Promise<void> {
    const page = await this.page();
    const handle = await this.resolveTarget(page, target);
    await this.moveTo(page, handle);
    await page.mouse.down();
    await page.waitForTimeout(45 + Math.floor(Math.random() * 70));
    await page.mouse.up();
  }

  private async moveMouseTo(page: Page, x: number, y: number, steps = 12): Promise<void> {
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
    await this.moveMouseTo(page, x, y, 14);
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

  private async frameBox(frame: Frame): Promise<WidgetBox | undefined> {
    try {
      const box = await frame.locator("body").boundingBox({ timeout: 1500 });
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

  async listFrames(): Promise<FrameSummary[]> {
    const page = await this.page();
    const frames = page.frames();
    const summaries: FrameSummary[] = [];
    for (const frame of frames) {
      const box = await this.frameBox(frame);
      summaries.push({
        url: frame.url(),
        name: frame.name(),
        ...(box
          ? { box: { x: box.x, y: box.y, width: box.width, height: box.height } }
          : {}),
      });
    }
    return summaries;
  }

  private async findTurnstileWidget(page: Page): Promise<WidgetBox | undefined> {
    const preferred = page.frames().filter((frame) => isCloudflareFrameUrl(frame.url()));
    const ordered = [...preferred, ...page.frames().filter((frame) => !preferred.includes(frame))];
    let fallback: WidgetBox | undefined;
    for (const frame of ordered) {
      const box = await this.frameBox(frame);
      if (!box) continue;
      // Interactive Turnstile widget is typically ~300x65; ignore full-page frames.
      if (box.width >= 200 && box.width <= 420 && box.height >= 50 && box.height <= 120) {
        return box;
      }
      if (isCloudflareFrameUrl(frame.url()) && box.width >= 120 && box.height >= 40) {
        fallback ??= box;
      }
    }
    return fallback;
  }

  async detectChallenge(): Promise<ChallengeDetection> {
    const page = await this.page();
    const title = await page.title().catch(() => "");
    const url = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const frames = page.frames().map((frame) => ({ url: frame.url() }));
    const classified = classifyChallenge({
      title,
      url,
      bodyText,
      frameUrls: frames.map((frame) => frame.url),
    });
    const widget = classified.present ? await this.findTurnstileWidget(page) : undefined;
    return {
      present: classified.present,
      kind: classified.kind,
      title,
      url,
      bodySnippet: snippet(bodyText),
      ...(widget ? { widget } : {}),
      frames,
    };
  }

  async solveTurnstile(options: { timeoutMs?: number; maxClicks?: number } = {}): Promise<SolveTurnstileResult> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 45_000, 3_000), 180_000);
    const maxClicks = Math.min(Math.max(options.maxClicks ?? 12, 1), 30);
    const started = Date.now();
    const clicks: Array<{ x: number; y: number }> = [];
    const page = await this.page();

    const snapshot = async () => {
      const title = await page.title().catch(() => "");
      const url = page.url();
      const bodyText = await page.locator("body").innerText().catch(() => "");
      return { title, url, bodyText };
    };

    let initial = await this.detectChallenge();
    if (!initial.present) {
      const state = await snapshot();
      return {
        ok: true,
        method: "already_clear",
        attempts: 0,
        elapsedMs: Date.now() - started,
        title: state.title,
        url: state.url,
        bodySnippet: snippet(state.bodyText),
        clicks,
      };
    }

    // Wait for the widget frame to finish mounting.
    let widget = initial.widget;
    while (!widget && Date.now() - started < Math.min(15_000, timeoutMs)) {
      await page.waitForTimeout(350);
      widget = await this.findTurnstileWidget(page);
      initial = await this.detectChallenge();
      if (!initial.present) {
        const state = await snapshot();
        return {
          ok: true,
          method: "already_clear",
          attempts: 0,
          elapsedMs: Date.now() - started,
          title: state.title,
          url: state.url,
          bodySnippet: snippet(state.bodyText),
          clicks,
        };
      }
    }

    if (!widget) {
      const state = await snapshot();
      return {
        ok: false,
        method: "not_found",
        attempts: 0,
        elapsedMs: Date.now() - started,
        title: state.title,
        url: state.url,
        bodySnippet: snippet(state.bodyText),
        clicks,
        error: "未找到跨域 challenge 控件区域",
      };
    }

    // Human-ish warm-up path near the widget.
    for (const point of warmUpPath(widget)) {
      if (Date.now() - started > timeoutMs) break;
      await this.moveMouseTo(page, point.x, point.y, 8 + Math.floor(Math.random() * 6));
      await page.waitForTimeout(60 + Math.floor(Math.random() * 120));
    }

    const candidates = checkboxClickCandidates(widget);
    let attempts = 0;

    while (Date.now() - started < timeoutMs && attempts < maxClicks) {
      // Refresh widget box — layout can shift after partial verification.
      widget = (await this.findTurnstileWidget(page)) ?? widget;
      const queue = attempts === 0
        ? candidates
        : checkboxClickCandidates(widget);
      const target = queue[attempts % queue.length] ?? {
        x: widget.x + 40,
        y: widget.y + widget.height / 2,
      };
      // Tiny jitter so repeated attempts are not pixel-identical.
      const x = target.x + (Math.random() - 0.5) * 4;
      const y = target.y + (Math.random() - 0.5) * 3;
      attempts += 1;
      clicks.push({ x, y });
      await this.moveMouseTo(page, x, y, 16);
      await page.waitForTimeout(100 + Math.floor(Math.random() * 180));
      await page.mouse.down();
      await page.waitForTimeout(50 + Math.floor(Math.random() * 80));
      await page.mouse.up();

      // Poll briefly after each click for clearance.
      const deadline = Math.min(Date.now() + 5_000, started + timeoutMs);
      while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        const state = await snapshot();
        if (!looksCleared({ ...state, hadChallenge: true })) continue;
        // Confirm the page stays clear briefly (avoid interim "Loading…" flashes).
        await page.waitForTimeout(700);
        const confirmed = await snapshot();
        if (looksCleared({ ...confirmed, hadChallenge: true })) {
          return {
            ok: true,
            method: "click",
            attempts,
            elapsedMs: Date.now() - started,
            title: confirmed.title,
            url: confirmed.url,
            bodySnippet: snippet(confirmed.bodyText),
            widget,
            clicks,
          };
        }
      }
    }

    const state = await snapshot();
    const cleared = looksCleared({ ...state, hadChallenge: true });
    return {
      ok: cleared,
      method: cleared ? "click" : "timeout",
      attempts,
      elapsedMs: Date.now() - started,
      title: state.title,
      url: state.url,
      bodySnippet: snippet(state.bodyText),
      widget,
      clicks,
      ...(cleared ? {} : { error: "在超时时间内未能离开 interstitial 页面" }),
    };
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
