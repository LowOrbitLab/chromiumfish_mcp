import { existsSync } from "node:fs";
import type { Stats } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { buildArgs, ChromiumFish } from "chromiumfish";
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Download,
  ElementHandle,
  Frame,
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from "playwright-core";
import { chromium } from "playwright-core";
import { snapshotRole } from "./aria.js";
import { SNAPSHOT_CHARS, SNAPSHOT_ELEMENTS, TEXT_CHARS } from "./config.js";
import type { ServerConfig } from "./config.js";
import {
  checkboxClickCandidates,
  classifyChallenge,
  inferWidgetState,
  initialCursorPos,
  isCloudflareFrameUrl,
  isGateTitle,
  isVerifyingPhase,
  looksCleared,
  snippet,
  SOLVE_MAX_CLICKS,
  SOLVE_TIMEOUT_MS,
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
  /** HTTP status of the document, when this summary came from opening a URL. */
  status?: number;
}

/**
 * A JavaScript dialog that opened and was answered. Dialogs are answered the moment they
 * open — Playwright freezes the page until a listener responds, so holding one open would
 * hang every later call — which makes this a record of what happened, not a prompt.
 */
export interface DialogRecord {
  type: string;
  message: string;
  /** True when the dialog was accepted; false when dismissed (cancel). */
  accepted: boolean;
  /** Text supplied to a prompt, when one was accepted with a value. */
  promptText?: string;
}

export type DownloadState = "saved" | "pending" | "failed" | "discarded";

export interface DownloadRecord {
  url: string;
  /** The name the server suggested, before it was made safe to write. */
  suggestedFilename: string;
  /** Base name actually written. Absent while pending, or when nothing was kept. */
  file?: string;
  bytes?: number;
  state: DownloadState;
  /** Why a download failed, or why it was not kept. */
  error?: string;
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
  /**
   * The action started a top-level navigation that is never arriving: blocked by
   * --allowed-host, a host that does not resolve, a scheme handed off to another
   * application. The action ran; the page simply did not move, and waiting for the
   * destination would wait forever. Without this the result is an ordinary
   * ok / navigated: false, which reads as though the click did nothing at all.
   */
  navigationFailed?: { url: string; reason: string };
  /**
   * HTTP status of the document this action loaded. Only the navigation tools carry one:
   * they hold the response object. A 404 or a 500 loads like any other page, so without
   * this an error page reads as a successful navigation.
   */
  status?: number;
  /**
   * Dialogs that opened during the action, already answered. An unarmed confirm is
   * dismissed, so a click that raised one did *not* do what the button said — read this
   * before concluding the action took effect. Use handle_dialog to answer the next one.
   */
  dialogs?: DialogRecord[];
  /** Dialogs beyond the reported ones; a page looping alert() is the usual cause. */
  dialogsOmitted?: number;
  /** Downloads the action started. State may still be pending; list_downloads settles it. */
  downloads?: DownloadRecord[];
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

/** Confirmation that the next dialog's answer is armed, and on which page. */
export interface DialogArmed {
  pageId: string;
  accept: boolean;
  promptText?: string;
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
  handleDialog(accept: boolean, promptText?: string): Promise<DialogArmed>;
  listDownloads(): Promise<DownloadRecord[]>;
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
const LINE_TRUNCATION_SUFFIX = " [line truncated]";
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

/** How many dialogs one action reports before it starts counting them instead. */
const MAX_REPORTED_DIALOGS = 5;
/** Dialog message text kept per record; a page can put a novel in one. */
const MAX_DIALOG_MESSAGE = 300;
/** Cap on the session download log, so a page downloading in a loop cannot grow it forever. */
const MAX_DOWNLOAD_LOG = 100;

/**
 * Collects what a page did to itself while one action was running. Dialogs and downloads
 * arrive on context events with no tie to the call that caused them, so an open window is
 * how a result learns that its own click raised a confirm.
 */
interface SideEffectSink {
  page: Page;
  dialogs: DialogRecord[];
  dialogCount: number;
  downloads: DownloadRecord[];
}

/** Page state captured before an action so the result can report what changed. */
interface ActionBaseline {
  url: string;
  pages: Page[];
  /** Resolves once the main frame commits a new document, or the navigation is cancelled. */
  settled: Promise<void>;
  /** A top-level navigation has been requested but has not committed yet. */
  pending: () => boolean;
  /** The top-level navigation the action started, and why it never arrived. */
  failure: () => { url: string; reason: string } | undefined;
  /** Dialogs answered and downloads started while this window was open. */
  sink: SideEffectSink;
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

/** The line snapshot appends when its output was cut short, counting what it did report. */
function truncationMarker(elements: number): string {
  return `[Snapshot truncated after ${elements} elements; ${SNAPSHOT_TRUNCATION_MARKER}]`;
}

/**
 * The facts snapshot needs from one element, read inside the page.
 *
 * Raw facts only: the HTML-to-ARIA mapping lives in aria.ts so it can be unit-tested
 * without a DOM. Lifted to module scope so a batch hands every element the same function
 * instead of rebuilding a closure per element, and so snapshot's own budget accounting
 * stays legible next to it.
 */
const snapshotElementInfo = (element: HTMLElement | SVGElement) => {
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
};

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

/**
 * Reduce a server-suggested download name to something safe to write.
 *
 * suggestedFilename derives from the remote origin's Content-Disposition, so its content is
 * chosen by whoever the page decided to fetch from. Chromium does normalize it first —
 * measured against a server sending `../../../evil:name.pdf`, what arrives here is already
 * `_.._.._evil_name.pdf` — but that is Chromium's behavior, not a guarantee Playwright
 * makes, and its own docs only say the name is "typically computed by the browser". A
 * download name that reaches the filesystem unchecked is not the place to inherit someone
 * else's invariant.
 *
 * Both separators are stripped regardless of host platform, since the name travels from a
 * Linux server to a Windows disk as easily as the reverse, and what survives is filtered to
 * a conservative allowed set rather than checked against a list of known-bad characters.
 *
 * The caller still confirms the resolved path sits inside the download root: this function
 * is the first of two checks, not the only one.
 */
export function safeDownloadName(suggested: string): string {
  const base = suggested.split(/[/\\]/).pop() ?? "";
  const cleaned = base
    // Control characters, the set Windows forbids outright, and anything else exotic.
    // Written as escapes, not as the bytes themselves: a literal NUL here made ripgrep
    // classify this whole file as binary and skip it, so searches for anything in it came
    // back empty rather than failing. test/config.test.mjs guards against writing them back.
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "")
    // Leading dots would hide the file; trailing dots and spaces are dropped by Windows
    // anyway, which would silently change the name out from under the reported one.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 100);
  if (!cleaned) return "download";
  // CON.txt still resolves to the console device on Windows, extension and all.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) return `download-${cleaned}`;
  return cleaned;
}

/** First free name in dir: "report.pdf", then "report (2).pdf", and so on. */
async function uniqueDownloadPath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = join(dir, index === 1 ? name : `${stem} (${index})${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Too many downloads already named ${name}`);
}

export class ChromiumFishBrowser implements BrowserApi {
  private browser?: Browser;
  private context?: BrowserContext;
  private currentPage?: Page;
  private readonly pageIds = new WeakMap<Page, string>();
  private nextPageId = 1;
  private readonly frameIds = new WeakMap<Frame, string>();
  private nextFrameId = 1;
  /** Pages already carrying the close listener, so trackPage cannot stack duplicates. */
  private readonly trackedPages = new WeakSet<Page>();
  private readonly refs = new WeakMap<Page, Map<string, InteractiveHandle>>();
  /** Never reset, not even per page: reusing a number would make a stale ref resolve silently. */
  private nextRefId = 1;
  private readonly mousePositions = new WeakMap<Page, { x: number; y: number }>();
  /** Prevent concurrent solve_challenge runs from fighting over the same mouse. */
  private solveChallengeInFlight = false;
  /**
   * Browser start and page acquisition in flight, so concurrent tool calls join the one
   * already running instead of each starting its own. MCP dispatches tool calls
   * concurrently — the SDK does not await one handler before reading the next request — so
   * two of them routinely arrive while the browser is still launching.
   */
  private contextStart?: Promise<BrowserContext>;
  private pageStart?: Promise<Page>;
  /** Set by close(), so a tool call arriving during shutdown cannot start a new browser. */
  private closing = false;
  /** Answer armed by handle_dialog for the next dialog on that page; consumed once. */
  private readonly armedDialogs = new WeakMap<Page, { accept: boolean; promptText?: string }>();
  /** Active action windows collecting what happened while they are open. */
  private readonly sideEffectSinks = new Set<SideEffectSink>();
  /** Everything downloaded this session, newest last. */
  private readonly downloadLog: DownloadRecord[] = [];

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

  /**
   * Latch the launch so two callers share one browser. Without it the second call to arrive
   * during a launch starts a browser of its own; the later assignment wins and the earlier
   * browser is never closed, since close() only knows about this.browser. A failed start
   * clears the latch, so the next call retries rather than joining a rejected promise.
   */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.closing) throw new Error("Browser is shutting down");
    if (this.context && this.browser?.isConnected()) return this.context;
    this.contextStart ??= this.startContext().finally(() => {
      this.contextStart = undefined;
    });
    return this.contextStart;
  }

  private async startContext(): Promise<BrowserContext> {
    const nativeAgentArgs = this.nativeAgentArgs();
    if (this.config.chromePath) {
      if (!existsSync(this.config.chromePath)) {
        throw new Error(`ChromiumFish executable does not exist: ${this.config.chromePath}`);
      }
      if (this.config.timezone === "auto") {
        throw new Error("--chrome-path does not support --timezone auto; specify an IANA time zone or system");
      }
      // Only the upstream helper below selects a build; a local executable *is* the build.
      // Ignoring the flag silently would launch a version the caller did not ask for.
      if (this.config.browserVersion) {
        throw new Error(
          "--chrome-path does not support --browser-version; the local executable is the build that runs",
        );
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
    // Both are registered unconditionally. The dialog listener has to be, or Playwright
    // goes on silently dismissing; the download listener has to be, or a discarded
    // download is never reported as having happened at all.
    this.installDialogHandler(this.context);
    this.installDownloadHandler(this.context);
    await this.installNavigationGuard(this.context);
    return this.context;
  }

  /**
   * Answer every JavaScript dialog the moment it opens, and record what was answered.
   *
   * Playwright dismisses dialogs only while nothing is listening; the instant a listener
   * exists it owns the response, and a listener that returns without answering freezes the
   * page — "actions like click will never finish", per its own docs. So this never awaits
   * anything before responding and never throws: the fallback dismiss below runs even if
   * reading the dialog's own fields fails.
   *
   * The default answer is dismiss, which is what an unlistened dialog already got, so
   * nothing about page behavior changes here. What changes is that the answer is now
   * reported: a confirm() dismissed behind a click means the click did not do what its
   * label said, and that used to surface as an ordinary successful action.
   */
  private installDialogHandler(context: BrowserContext): void {
    context.on("dialog", (dialog) => {
      let record: DialogRecord = { type: "unknown", message: "", accepted: false };
      let armed: { accept: boolean; promptText?: string } | undefined;
      try {
        const page = dialog.page();
        armed = page ? this.armedDialogs.get(page) : undefined;
        if (page && armed) this.armedDialogs.delete(page);
        record = {
          type: dialog.type(),
          // beforeunload is the one dialog Playwright accepts by default, because
          // dismissing it cancels the navigation the caller just asked for.
          accepted: armed?.accept ?? dialog.type() === "beforeunload",
          message: dialog.message().slice(0, MAX_DIALOG_MESSAGE),
        };
        if (armed?.accept && armed.promptText !== undefined) record.promptText = armed.promptText;
      } catch {
        // Fall through to the dismiss below; an unanswered dialog is the one outcome that
        // cannot be allowed, and a half-built record is still worth reporting.
      }
      for (const sink of this.sideEffectSinks) {
        if (sink.page !== dialog.page()) continue;
        sink.dialogCount += 1;
        if (sink.dialogs.length < MAX_REPORTED_DIALOGS) sink.dialogs.push(record);
      }
      const answer = record.accepted
        ? dialog.accept(record.promptText)
        : dialog.dismiss();
      answer.catch(() => undefined);
    });
  }

  async handleDialog(accept: boolean, promptText?: string): Promise<DialogArmed> {
    const page = await this.page();
    const armed: { accept: boolean; promptText?: string } = { accept };
    if (promptText !== undefined) armed.promptText = promptText;
    this.armedDialogs.set(page, armed);
    return { pageId: this.pageId(page), ...armed };
  }

  /**
   * Open a window over the side effects a page produces on its own. Every caller must
   * close it, or the sink outlives the action and collects someone else's dialogs.
   */
  private openSideEffectSink(page: Page): { sink: SideEffectSink; close: () => void } {
    const sink: SideEffectSink = { page, dialogs: [], dialogCount: 0, downloads: [] };
    this.sideEffectSinks.add(sink);
    return { sink, close: () => this.sideEffectSinks.delete(sink) };
  }

  /** Copy a sink's findings onto a result, leaving the fields off when nothing happened. */
  private applySideEffects(result: ActionResult, sink: SideEffectSink): void {
    if (sink.dialogs.length > 0) result.dialogs = sink.dialogs;
    if (sink.dialogCount > sink.dialogs.length) {
      result.dialogsOmitted = sink.dialogCount - sink.dialogs.length;
    }
    if (sink.downloads.length > 0) result.downloads = sink.downloads;
  }

  /**
   * Record every download, and keep it only when a root was configured.
   *
   * The transfer itself is always accepted, so a page whose flow depends on one behaves the
   * same either way; what --download-dir decides is whether the bytes survive. A server
   * without it used to leave downloads in Playwright's temp directory to be deleted on
   * close, which from the caller's side is indistinguishable from the click doing nothing.
   */
  private installDownloadHandler(context: BrowserContext): void {
    context.on("download", (download) => {
      const suggested = download.suggestedFilename();
      const record: DownloadRecord = {
        url: download.url(),
        suggestedFilename: suggested,
        state: this.config.downloadDir ? "pending" : "discarded",
      };
      if (!this.config.downloadDir) {
        record.error = "Downloads are discarded; start the server with --download-dir to keep them";
      }
      this.downloadLog.push(record);
      if (this.downloadLog.length > MAX_DOWNLOAD_LOG) this.downloadLog.shift();
      for (const sink of this.sideEffectSinks) {
        if (sink.page === download.page()) sink.downloads.push(record);
      }
      // Mutated in place afterwards, so a record already handed to an action result settles
      // to saved or failed rather than staying pending in a caller's hands.
      void this.saveDownload(download, record);
    });
  }

  private async saveDownload(download: Download, record: DownloadRecord): Promise<void> {
    const dir = this.config.downloadDir;
    if (!dir) {
      await download.delete().catch(() => undefined);
      return;
    }
    try {
      await mkdir(dir, { recursive: true });
      const target = await uniqueDownloadPath(dir, safeDownloadName(record.suggestedFilename));
      // Second check, after the name was already reduced to a bare base name: nothing built
      // from remote input reaches saveAs without being proven to land inside the root.
      const root = await realpath(dir);
      const rel = relative(root, resolve(target));
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`refused to write outside ${dir}`);
      }
      await download.saveAs(target);
      const info = await stat(target);
      record.file = basename(target);
      record.bytes = info.size;
      record.state = "saved";
    } catch (error) {
      record.state = "failed";
      record.error = error instanceof Error ? error.message : String(error);
    }
  }

  async listDownloads(): Promise<DownloadRecord[]> {
    return this.downloadLog.map((record) => ({ ...record }));
  }

  /**
   * Second enforcement point for --allowed-host, behind the per-tool assertNavigationUrl:
   * this one catches navigations the page starts on its own — a redirect, a link, a form
   * post, a popup — which no tool call passes through.
   *
   * Interception is not free, and the cost is not only latency. Playwright's own note on
   * route is "Enabling routing disables http cache", so every subresource on every page
   * round-trips through Node and nothing survives to the next visit. On a browser whose
   * reason to exist is looking ordinary to a challenge, that second part is the one that
   * matters: a real browser caches, and one that re-fetches everything it already has is
   * anomalous. The route is still worth it — a navigation guard that only covers tool calls
   * is not a guard — but it stays off entirely unless a host list was configured.
   */
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
    // page() re-tracks a tab it falls back to after the current one closed, so this runs
    // more than once for the same page and would otherwise stack a close listener each
    // time, up to Node's MaxListenersExceededWarning. pageIds cannot serve as the marker:
    // listPages, selectPage, and closePage assign ids while scanning without tracking.
    if (this.trackedPages.has(page)) return;
    this.trackedPages.add(page);
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

  private async pageSummary(page: Page, status?: number): Promise<PageSummary> {
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
      ...(status === undefined ? {} : { status }),
    };
  }

  /**
   * Latched for the same reason as ensureContext: a fresh context has no pages, so two
   * concurrent tool calls would each open one and leave a stray tab behind.
   */
  private async page(): Promise<Page> {
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    this.pageStart ??= this.startPage().finally(() => {
      this.pageStart = undefined;
    });
    return this.pageStart;
  }

  private async startPage(): Promise<Page> {
    const context = await this.ensureContext();
    // Re-checked after the await: openPage may have selected one while the browser started.
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
      // Reported for the same reason the navigation tools report it: an error page loads
      // like any other, so without the status this reads as having opened the real thing.
      const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
      return this.pageSummary(page, response?.status());
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
    sink?: SideEffectSink,
    response?: PlaywrightResponse | null,
  ): Promise<ActionResult> {
    const opened = this.openPages().filter((candidate) => !priorPages.includes(candidate));
    for (const candidate of opened) this.trackPage(candidate);

    const result: ActionResult = {
      ok: true,
      url: page.url(),
      title: await page.title().catch(() => ""),
      navigated: true,
    };
    // Playwright resolves goto without complaint on a 404 or a 500 — only a network-level
    // failure throws — and plenty of sites answer both with a page that reads like content.
    // Null is normal: a same-document hash change, or a back with no history behind it.
    if (response) result.status = response.status();
    if (opened.length > 0) result.newPages = opened.map((candidate) => this.pageId(candidate));
    if (sink) this.applySideEffects(result, sink);
    if (options.returnSnapshot) result.snapshot = await this.snapshot();
    return result;
  }

  /**
   * The shared body of the four navigation tools: clear refs, watch for what the page does
   * to itself while it moves, and report the response the move produced.
   */
  private async navigationAction(
    page: Page,
    options: ActionOptions | undefined,
    run: () => Promise<PlaywrightResponse | null>,
  ): Promise<ActionResult> {
    // Captured after the caller resolved the page, so the page a lazy browser start just
    // created is not reported as one this navigation opened.
    const priorPages = this.openPages();
    await this.clearRefs(page);
    const { sink, close } = this.openSideEffectSink(page);
    try {
      const response = await run();
      return await this.navigationResult(page, priorPages, options, sink, response);
    } finally {
      close();
    }
  }

  /**
   * Snapshot the page state an action starts from, and arm the navigation listeners.
   *
   * They are armed here, before the action runs, because Playwright offers no way to ask
   * afterwards whether a navigation is in flight: the request can be issued and the document
   * torn down before the first read, and by then the only evidence has already gone past.
   */
  private actionBaseline(page: Page): ActionBaseline {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    /** The main-frame navigation request this action started, until it commits or dies. */
    let navigation: PlaywrightRequest | undefined;
    let done = false;
    let failure: { url: string; reason: string } | undefined;
    const onRequest = (request: PlaywrightRequest) => {
      if (navigation || done || !request.isNavigationRequest()) return;
      // frame() throws once a frame is detached, which only means this is not the main one.
      try {
        if (request.frame() !== page.mainFrame()) return;
      } catch {
        return;
      }
      navigation = request;
    };
    const onNavigated = (frame: Frame) => {
      if (frame !== page.mainFrame()) return;
      done = true;
      // A retried navigation whose first attempt failed did arrive after all.
      failure = undefined;
      settle();
    };
    /**
     * A cancelled navigation never fires framenavigated, and without this listener it is
     * indistinguishable from one that is merely slow: the wait in actionResult would run to
     * its full ten seconds and then report navigationPending on a navigation that is never
     * coming — which the instructions tell the model means "it worked, wait for the
     * destination", so it goes on to spend a wait_for timeout on a page that will never
     * load. --allowed-host aborts one on every blocked link, Chromium aborts one whenever a
     * navigation turns out to be a download, and an unresolvable host does the same.
     */
    const onRequestFailed = (request: PlaywrightRequest) => {
      if (done || request !== navigation) return;
      navigation = undefined;
      failure = { url: request.url(), reason: request.failure()?.errorText ?? "unknown" };
      // settled only ever resolves once, so a page that fails one navigation and then starts
      // another gets reported as pending without a second wait. That is the rare case, and
      // it still beats the ten seconds every cancelled navigation used to cost.
      settle();
    };
    page.on("request", onRequest);
    page.on("framenavigated", onNavigated);
    page.on("requestfailed", onRequestFailed);
    const { sink, close } = this.openSideEffectSink(page);

    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      page.off("request", onRequest);
      page.off("framenavigated", onNavigated);
      page.off("requestfailed", onRequestFailed);
      close();
    };
    // These listeners cannot change any outcome once the commit window has closed, so that
    // window is their lifetime. Enforcing it here rather than relying on release() alone is
    // what keeps an action that throws on its way to actionResult — a setInputFiles timeout,
    // a failed selectOption — from leaving a set attached for the rest of the session.
    const expiry = setTimeout(detach, ACTION_NAV_COMMIT_TIMEOUT_MS + ACTION_LOAD_TIMEOUT_MS);
    expiry.unref?.();

    return {
      url: page.url(),
      pages: this.openPages(),
      settled,
      pending: () => navigation !== undefined && !done,
      failure: () => failure,
      sink,
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
          baseline.settled,
          page.waitForTimeout(ACTION_NAV_COMMIT_TIMEOUT_MS).catch(() => undefined),
        ]).catch(() => undefined);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: ACTION_LOAD_TIMEOUT_MS })
        .catch(() => undefined);

      // Still in flight after the bound above: a slow endpoint or a redirect chain. Report
      // that rather than let the stale reads below read as "the action did nothing".
      const navigationPending = baseline.pending();
      const failure = baseline.failure();
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
      // A navigation that became a download did not fail: Chromium aborts the request and
      // hands the transfer to the download manager, and downloads below already says so.
      // Reporting it as a failed navigation would describe a working download as a dead end.
      const becameDownload = baseline.sink.downloads.length > 0
        && failure?.reason.includes("ERR_ABORTED") === true;
      if (failure && !navigationPending && !becameDownload) result.navigationFailed = failure;
      if (opened.length > 0) result.newPages = opened.map((candidate) => this.pageId(candidate));
      // Before the snapshot, so a page that raised a dialog still reports it even if the
      // snapshot below throws.
      this.applySideEffects(result, baseline.sink);
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
    return this.navigationAction(page, options, () => page.goto(url.href, { waitUntil: "domcontentloaded" }));
  }

  async navigateBack(options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    return this.navigationAction(page, options, () => page.goBack({ waitUntil: "domcontentloaded" }));
  }

  async navigateForward(options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    return this.navigationAction(page, options, () => page.goForward({ waitUntil: "domcontentloaded" }));
  }

  async reload(options?: ActionOptions): Promise<ActionResult> {
    const page = await this.page();
    return this.navigationAction(page, options, () => page.reload({ waitUntil: "domcontentloaded" }));
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

  /**
   * readThroughNavigation covers the element query, but the per-element reads below it are
   * the long part of the call, and each swallows its own error so one detached element
   * costs only itself. A navigation committing mid-scan fails every one of them at once,
   * and the scan would then report "(No visible interactive elements)" for a page full of
   * them — a result that reads as an answer. So a scan that saw the document go away is
   * thrown out and taken again against the document that replaced it.
   */
  async snapshot(options: SnapshotOptions = {}): Promise<string> {
    const page = await this.page();
    const first = await this.snapshotOnce(page, options);
    if (!first.raced) return first.text;
    await page.waitForLoadState("domcontentloaded", { timeout: ACTION_LOAD_TIMEOUT_MS })
      .catch(() => undefined);
    return (await this.snapshotOnce(page, options)).text;
  }

  private async snapshotOnce(
    page: Page,
    options: SnapshotOptions,
  ): Promise<{ text: string; raced: boolean }> {
    // Here rather than in snapshot(), so a retry releases the handles the first scan
    // retained instead of abandoning them.
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
      SNAPSHOT_ELEMENTS.default,
      SNAPSHOT_ELEMENTS.min,
      SNAPSHOT_ELEMENTS.max,
    );
    const maxChars = clampInteger(
      options.maxChars,
      SNAPSHOT_CHARS.default,
      SNAPSHOT_CHARS.min,
      this.config.maxTextChars,
    );
    /**
     * Set when a read failed because the document went away. Every handle in one scan
     * belongs to a single frame — locators do not descend into iframes — so one element
     * reporting the race means the whole scan is describing a document that is gone.
     */
    let raced = false;
    const noteRace = (error: unknown): void => {
      if (isNavigationRace(error)) raced = true;
    };
    const refs = new Map<string, InteractiveHandle>();
    const retained = new Set<InteractiveHandle>();
    /** Committed lines, each paired with what dropping it again would have to release. */
    const printed: Array<{ text: string; ref: string; handle: InteractiveHandle }> = [];
    let outputChars = 0;
    let truncated = false;
    let completed = false;

    try {
      outer: for (let start = 0; start < handles.length; start += HANDLE_BATCH_SIZE) {
        const batch = handles.slice(start, start + HANDLE_BATCH_SIZE);
        const visible = await Promise.all(
          batch.map((handle) => handle.isVisible().catch((error: unknown) => {
            noteRace(error);
            return false;
          })),
        );
        const candidates = batch.filter((handle, offset) => Boolean(handle && visible[offset]));
        // One concurrent wave per batch instead of a round trip per element in series. A
        // 250-element page used to cost 250 sequential CDP calls in the most frequently
        // called tool on the surface. Each read keeps its own catch, so an element that
        // detaches mid-read still only costs itself. Reading a few elements the budget then
        // truncates away is bounded by the batch size and buys no extra round trips.
        const infos = await Promise.all(
          candidates.map((handle) => handle.evaluate(snapshotElementInfo).catch((error: unknown) => {
            noteRace(error);
            return null;
          })),
        );

        for (let offset = 0; offset < candidates.length; offset += 1) {
          if (refs.size >= maxElements) {
            truncated = true;
            break outer;
          }

          const handle = candidates[offset];
          const info = infos[offset];
          if (!handle || !info) continue;

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
          const separatorChars = printed.length > 0 ? 1 : 0;
          if (line.length + separatorChars > maxChars && printed.length === 0) {
            // The marker is appended unconditionally below, so its budget has to come out of
            // this line. Sizing the line to maxChars alone leaves the pair over budget, and
            // the loop that enforces the budget would then drop the only line there is —
            // returning a bare marker that reports an element the caller never saw.
            const room = maxChars - truncationMarker(1).length - 1 - LINE_TRUNCATION_SUFFIX.length;
            line = `${line.slice(0, Math.max(0, room))}${LINE_TRUNCATION_SUFFIX}`;
            truncated = true;
          } else if (outputChars + separatorChars + line.length > maxChars) {
            truncated = true;
            break outer;
          }

          refs.set(ref, handle);
          retained.add(handle);
          printed.push({ text: line, ref, handle });
          outputChars += separatorChars + line.length;
          if (truncated) break outer;
        }
      }

      this.refs.set(page, refs);
      completed = true;
      const render = () => (printed.length > 0
        ? `${printed.map((entry) => entry.text).join("\n")}\n${truncationMarker(printed.length)}`
        : truncationMarker(0));
      if (!truncated) {
        // Per-line accounting already kept the body within maxChars.
        return {
          text: printed.length > 0
            ? printed.map((entry) => entry.text).join("\n")
            : "(No visible interactive elements)",
          raced,
        };
      }
      // Append the marker and, if the body is still char-bound, drop trailing lines so the
      // marker survives the budget instead of being clipped away. Dropping a line releases
      // its reference too: one the caller never sees is a handle held for nothing, and it
      // would leave the marker's count describing more than was actually reported.
      let output = render();
      while (output.length > maxChars && printed.length > 0) {
        const dropped = printed.pop();
        if (dropped) {
          refs.delete(dropped.ref);
          retained.delete(dropped.handle);
        }
        output = render();
      }
      return { text: output, raced };
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
    const maxChars = clampInteger(
      options.maxChars,
      TEXT_CHARS.default,
      TEXT_CHARS.min,
      this.config.maxTextChars,
    );
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

    // Playwright scrolls every ancestor scroll container on the way to the element, not just
    // the window, so putting back window.scrollX/Y alone still leaves a target inside an
    // overflow container displaced. Capture the ancestor chain in the element's own frame,
    // and the main frame's window separately, since the element's frame may not be the main
    // one. A scrolled frame between those two is not restored — nesting that deep is rare
    // enough not to be worth walking the frame tree for.
    const inner = await handle.evaluate((element) => {
      const chain: Array<[number, number]> = [];
      for (let node: Element | null = element; node; node = node.parentElement) {
        chain.push([node.scrollLeft, node.scrollTop]);
      }
      return { chain, window: [window.scrollX, window.scrollY] as [number, number] };
    }).catch(() => undefined);
    const origin = await page.evaluate(() => [window.scrollX, window.scrollY] as [number, number])
      .catch(() => undefined);
    try {
      return await handle.screenshot({ type: "png" });
    } finally {
      // Best effort: a capture that succeeded must still be returned even if the page went
      // away before the scroll could be put back.
      if (inner) {
        await handle.evaluate((element, saved) => {
          let index = 0;
          for (let node: Element | null = element; node && index < saved.chain.length; node = node.parentElement) {
            const position = saved.chain[index];
            index += 1;
            if (!position) continue;
            node.scrollLeft = position[0];
            node.scrollTop = position[1];
          }
          window.scrollTo(saved.window[0], saved.window[1]);
        }, inner).catch(() => undefined);
      }
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
    if (isGateTitle(title)) return "";

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
        challengeObserved: false,
        interactionPerformed: false,
        clearanceVerified: false,
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
    const timeoutMs = clampInteger(
      options.timeoutMs,
      SOLVE_TIMEOUT_MS.default,
      SOLVE_TIMEOUT_MS.min,
      SOLVE_TIMEOUT_MS.max,
    );
    const maxClicks = clampInteger(
      options.maxClicks,
      SOLVE_MAX_CLICKS.default,
      SOLVE_MAX_CLICKS.min,
      SOLVE_MAX_CLICKS.max,
    );
    const started = Date.now();
    const clicks: Array<{ x: number; y: number }> = [];
    const page = await this.page();
    /** How many times we entered verifying and exited still uncleared. */
    let stuckVerifyingRounds = 0;
    const maxStuckVerifyingRounds = 2;
    /** Latched by observe(): whether a challenge was ever actually seen on this page. */
    let challengeObserved = false;
    type Observation = Awaited<ReturnType<ChromiumFishBrowser["observeChallenge"]>>;

    /**
     * Every observation in this method goes through here so challengeObserved cannot drift
     * from what was really detected. It latches: a challenge that clears mid-run was still
     * observed, and the result should say so.
     */
    const observe = async () => {
      const result = await this.observeChallenge(page);
      if (result.detection.present) challengeObserved = true;
      return result;
    };

    /**
     * `latest` hands over an observation the return site has just taken. Observing costs
     * four round trips — title, body text, the token field, the frame list — and taken
     * back to back with no wait in between the second one cannot see anything the first
     * did not. Return sites that waited or clicked since their last look omit it and get a
     * fresh read.
     */
    const finish = async (
      partial: Omit<
        ChallengeSolveResult,
        "elapsedMs" | "title" | "url" | "bodySnippet" | "widgetState" | "tokenPresent"
        | "challengeObserved" | "interactionPerformed"
      > & {
        widgetState?: WidgetState;
        tokenPresent?: boolean;
      },
      latest?: Observation,
    ): Promise<ChallengeSolveResult> => {
      const observed = latest ?? await this.observeChallenge(page);
      return {
        ...partial,
        // Derived here rather than passed in. A return site that spelled these out could
        // claim an interaction that never happened, which is the exact misreport they exist
        // to prevent; clicks and the observation log are the only sources.
        challengeObserved,
        interactionPerformed: partial.clicks.length > 0,
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
      observed: Observation,
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
        const observed = await observe();
        if (looksCleared(clearanceInput(observed, kind))) {
          // Confirm briefly.
          await page.waitForTimeout(500);
          const confirmed = await observe();
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
      const end = await observe();
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

    let observed = await observe();
    // Late-mounted challenge frames: wait briefly before concluding already_clear.
    if (!observed.detection.present) {
      const lateDeadline = started + 5_000;
      while (Date.now() < lateDeadline) {
        await page.waitForTimeout(400);
        observed = await observe();
        if (observed.detection.present) break;
      }
    }
    if (!observed.detection.present) {
      return finish({
        ok: true,
        method: "already_clear",
        clearanceVerified: false,
        attempts: 0,
        clicks,
        widgetState: observed.widgetState,
        tokenPresent: observed.tokenPresent,
      }, observed);
    }

    const kind = observed.kind;
    let widget = observed.detection.widget;

    // Wait for the widget frame to finish mounting.
    while (!widget && Date.now() - started < Math.min(15_000, timeoutMs)) {
      await page.waitForTimeout(350);
      observed = await observe();
      if (!observed.detection.present) {
        return finish({
          ok: true,
          method: "already_clear",
          clearanceVerified: false,
          attempts: 0,
          clicks,
          widgetState: observed.widgetState,
          tokenPresent: observed.tokenPresent,
        }, observed);
      }
      widget = observed.detection.widget;
    }

    if (!widget) {
      return finish({
        ok: false,
        method: "not_found",
        clearanceVerified: false,
        attempts: 0,
        clicks,
        reason: "not_found",
        error: "Cross-origin challenge control area not found",
      }, observed);
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

    // A challenge can finish its own automatic check while this runs, in which case nothing
    // was clicked and calling that "click" would claim an interaction that never happened.
    const clearedResult = (): Promise<ChallengeSolveResult> => finish({
      ok: true,
      method: attempts > 0 ? "click" : "self_cleared",
      clearanceVerified: true,
      attempts,
      clicks,
      widget,
    });

    const bumpStuckVerifying = (
      errorMessage: string,
    ): Promise<ChallengeSolveResult> | undefined => {
      stuckVerifyingRounds += 1;
      if (stuckVerifyingRounds < maxStuckVerifyingRounds) return undefined;
      return finish({
        ok: false,
        method: "timeout",
        clearanceVerified: false,
        attempts,
        clicks,
        widget,
        reason: "stuck_verifying",
        error: errorMessage,
      });
    };

    while (Date.now() - started < timeoutMs && attempts < maxClicks) {
      // If already verifying, do NOT click; only wait.
      observed = await observe();
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

    // This observation is the one the verdict below is drawn from, so it is also the one
    // reported: re-reading in finish would describe a page the verdict never looked at.
    observed = await observe();
    const cleared = looksCleared(clearanceInput(observed, kind));
    if (cleared) {
      return finish({
        ok: true,
        method: attempts > 0 ? "click" : "self_cleared",
        clearanceVerified: true,
        attempts,
        clicks,
        widget,
        widgetState: observed.widgetState,
        tokenPresent: observed.tokenPresent,
      }, observed);
    }
    const stuck = isVerifyingPhase({
      widgetState: observed.widgetState,
      bodyText: observed.bodyText,
      title: observed.detection.title,
    });
    return finish({
      ok: false,
      method: "timeout",
      clearanceVerified: false,
      attempts,
      clicks,
      widget,
      widgetState: observed.widgetState,
      tokenPresent: observed.tokenPresent,
      reason: stuck ? "stuck_verifying" : "timeout",
      error: stuck
        ? "The page remained in the Verifying state too long; stopped clicking"
        : "Could not confirm challenge clearance before the timeout",
    }, observed);
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
    // clickHandle rather than mouse.click: the latter presses and releases with no gap,
    // which is the one synthetic click this server would otherwise still emit.
    await this.clickHandle(page, handle);
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
    // Set before the awaits below, so a tool call that arrives during shutdown does not
    // start a browser this close() has already stopped waiting for.
    this.closing = true;
    // A launch already in flight resolves after this point and assigns this.browser and
    // this.context on its way out. Tearing down first would run against the very fields
    // that launch is about to repopulate, leaving a browser process nothing holds a
    // reference to any more — the shutdown edge of the same race the start latches exist
    // to prevent. allSettled because a launch that failed is one less thing to close.
    await Promise.allSettled([this.contextStart, this.pageStart]);
    const context = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    this.currentPage = undefined;
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
  }
}
