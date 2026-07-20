import { existsSync } from "node:fs";
import { buildArgs, ChromiumFish } from "chromiumfish";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  ElementHandle,
  Page,
} from "playwright-core";
import { chromium } from "playwright-core";
import type { ServerConfig } from "./config.js";

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
