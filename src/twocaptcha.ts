import type { LaunchOptions } from "playwright-core";
import type {
  CaptchaSolution,
  CaptchaSolver,
  ChallengeSolveOptions,
  ChallengeTarget,
} from "./challenge.js";

type FetchLike = typeof fetch;

interface TwoCaptchaClientOptions {
  fetchImpl?: FetchLike;
  pollingIntervalMs?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  proxy?: LaunchOptions["proxy"];
  forwardProxy?: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface TaskProxy {
  proxyType: "http" | "https" | "socks4" | "socks5";
  proxyAddress: string;
  proxyPort: number;
  proxyLogin?: string;
  proxyPassword?: string;
}

export class TwoCaptchaError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "TwoCaptchaError";
  }
}

const V1_BASE_URL = "https://2captcha.com";
const V2_BASE_URL = "https://api.2captcha.com";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function taskProxy(proxy: LaunchOptions["proxy"]): TaskProxy {
  if (!proxy) throw new TwoCaptchaError("A browser proxy is required for this challenge", "PROXY_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(proxy.server);
  } catch {
    throw new TwoCaptchaError("The browser proxy URL is invalid", "INVALID_PROXY");
  }
  const protocol = parsed.protocol.slice(0, -1).toLowerCase();
  if (!["http", "https", "socks4", "socks5"].includes(protocol)) {
    throw new TwoCaptchaError("The browser proxy protocol is not supported by 2Captcha", "INVALID_PROXY");
  }
  const defaultPort = protocol === "https" ? 443 : protocol.startsWith("socks") ? 1080 : 80;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TwoCaptchaError("The browser proxy address or port is invalid", "INVALID_PROXY");
  }
  return {
    proxyType: protocol as TaskProxy["proxyType"],
    proxyAddress: parsed.hostname,
    proxyPort: port,
    ...(proxy.username ? { proxyLogin: proxy.username } : {}),
    ...(proxy.password ? { proxyPassword: proxy.password } : {}),
  };
}

export class TwoCaptchaClient implements CaptchaSolver {
  private readonly fetchImpl: FetchLike;
  private readonly pollingIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly proxy?: LaunchOptions["proxy"];
  private readonly forwardProxy: boolean;

  constructor(
    private readonly apiKey: string,
    options: TwoCaptchaClientOptions = {},
  ) {
    if (!apiKey.trim()) throw new TwoCaptchaError("TWOCAPTCHA_API_KEY is not configured", "API_KEY_MISSING");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollingIntervalMs = Math.max(0, options.pollingIntervalMs ?? 5_000);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 20_000);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.proxy = options.proxy;
    this.forwardProxy = options.forwardProxy === true;
  }

  async solve(
    target: ChallengeTarget,
    options: Required<Pick<ChallengeSolveOptions, "timeoutMs">> & Pick<ChallengeSolveOptions, "minScore">,
  ): Promise<CaptchaSolution> {
    if (target.provider === "hcaptcha") return this.solveHcaptchaV1(target, options.timeoutMs);
    return this.solveV2(target, options);
  }

  private async requestJson(url: string, body: URLSearchParams | JsonRecord): Promise<JsonRecord> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const form = body instanceof URLSearchParams;
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: form ? { "content-type": "application/x-www-form-urlencoded" } : { "content-type": "application/json" },
        body: form ? body.toString() : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TwoCaptchaError(`2Captcha returned HTTP ${response.status}`, "HTTP_ERROR");
      }
      const value: unknown = await response.json();
      if (!isRecord(value)) throw new TwoCaptchaError("2Captcha returned an invalid JSON response", "INVALID_RESPONSE");
      return value;
    } catch (error) {
      if (error instanceof TwoCaptchaError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new TwoCaptchaError("The 2Captcha request timed out", "REQUEST_TIMEOUT");
      }
      throw new TwoCaptchaError("Could not reach the 2Captcha API", "NETWORK_ERROR");
    } finally {
      clearTimeout(timer);
    }
  }

  private assertV2Success(response: JsonRecord): void {
    const errorId = numberValue(response, "errorId") ?? 0;
    if (errorId === 0) return;
    const code = stringValue(response, "errorCode") ?? `API_ERROR_${errorId}`;
    const rawDescription = stringValue(response, "errorDescription") ?? "2Captcha rejected the request";
    const description = rawDescription.split(this.apiKey).join("[REDACTED]");
    throw new TwoCaptchaError(description, code);
  }

  private buildV2Task(target: ChallengeTarget, minScore?: number): JsonRecord {
    const proxy = this.forwardProxy ? taskProxy(this.proxy) : undefined;
    if (target.kind === "cloudflare_managed" && !proxy) {
      throw new TwoCaptchaError(
        "Cloudflare managed challenges require --2captcha-forward-proxy and a browser --proxy",
        "PROXY_REQUIRED",
      );
    }

    const common = {
      websiteURL: target.pageUrl,
      websiteKey: target.siteKey,
      ...(target.userAgent ? { userAgent: target.userAgent } : {}),
    };

    if (target.provider === "turnstile") {
      return {
        type: proxy ? "TurnstileTask" : "TurnstileTaskProxyless",
        ...common,
        ...(target.action ? { action: target.action } : {}),
        ...(target.cData ? { data: target.cData } : {}),
        ...(target.chlPageData ? { pagedata: target.chlPageData } : {}),
        ...(proxy ?? {}),
      };
    }

    if (target.kind === "recaptcha_v3") {
      return {
        type: "RecaptchaV3TaskProxyless",
        ...common,
        minScore: minScore ?? 0.3,
        pageAction: target.action ?? "verify",
        ...(target.enterprise ? { isEnterprise: true } : {}),
      };
    }

    const enterprise = target.kind === "recaptcha_enterprise" || target.enterprise === true;
    return {
      type: enterprise
        ? proxy ? "RecaptchaV2EnterpriseTask" : "RecaptchaV2EnterpriseTaskProxyless"
        : proxy ? "RecaptchaV2Task" : "RecaptchaV2TaskProxyless",
      ...common,
      ...(target.invisible !== undefined ? { isInvisible: target.invisible } : {}),
      ...(proxy ?? {}),
    };
  }

  private async solveV2(
    target: ChallengeTarget,
    options: Required<Pick<ChallengeSolveOptions, "timeoutMs">> & Pick<ChallengeSolveOptions, "minScore">,
  ): Promise<CaptchaSolution> {
    const created = await this.requestJson(`${V2_BASE_URL}/createTask`, {
      clientKey: this.apiKey,
      task: this.buildV2Task(target, options.minScore),
    });
    this.assertV2Success(created);
    const rawTaskId = created.taskId;
    if (typeof rawTaskId !== "number" && typeof rawTaskId !== "string") {
      throw new TwoCaptchaError("2Captcha did not return a task ID", "INVALID_RESPONSE");
    }
    const taskId = String(rawTaskId);
    const deadline = this.now() + options.timeoutMs;

    while (this.now() < deadline) {
      await this.sleep(Math.min(this.pollingIntervalMs, Math.max(0, deadline - this.now())));
      const result = await this.requestJson(`${V2_BASE_URL}/getTaskResult`, {
        clientKey: this.apiKey,
        taskId: rawTaskId,
      });
      this.assertV2Success(result);
      if (result.status === "processing") continue;
      if (result.status !== "ready" || !isRecord(result.solution)) {
        throw new TwoCaptchaError("2Captcha returned an invalid task result", "INVALID_RESPONSE");
      }
      const token = stringValue(result.solution, "token") ?? stringValue(result.solution, "gRecaptchaResponse");
      if (!token) throw new TwoCaptchaError("2Captcha returned no solution token", "INVALID_RESPONSE");
      return {
        taskId,
        token,
        ...(stringValue(result, "cost") ? { cost: stringValue(result, "cost") } : {}),
        ...(numberValue(result, "solveCount") !== undefined ? { solveCount: numberValue(result, "solveCount") } : {}),
      };
    }
    throw new TwoCaptchaError("2Captcha did not solve the challenge before the timeout", "CAPTCHA_TIMEOUT");
  }

  private v1Form(values: Record<string, string | number | boolean | undefined>): URLSearchParams {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) form.set(key, String(value));
    }
    return form;
  }

  private assertV1Success(response: JsonRecord): string {
    const request = stringValue(response, "request");
    if (response.status === 1 && request) return request;
    const code = request ?? "INVALID_RESPONSE";
    throw new TwoCaptchaError(code === "CAPCHA_NOT_READY" ? "The captcha is not ready" : "2Captcha rejected the request", code);
  }

  private async solveHcaptchaV1(target: ChallengeTarget, timeoutMs: number): Promise<CaptchaSolution> {
    const proxy = this.forwardProxy ? taskProxy(this.proxy) : undefined;
    const submitted = await this.requestJson(`${V1_BASE_URL}/in.php`, this.v1Form({
      key: this.apiKey,
      method: "hcaptcha",
      sitekey: target.siteKey,
      pageurl: target.pageUrl,
      invisible: target.invisible ? 1 : undefined,
      json: 1,
      proxy: proxy
        ? `${proxy.proxyLogin ? `${proxy.proxyLogin}:${proxy.proxyPassword ?? ""}@` : ""}${proxy.proxyAddress}:${proxy.proxyPort}`
        : undefined,
      proxytype: proxy?.proxyType.toUpperCase(),
    }));
    const taskId = this.assertV1Success(submitted);
    const deadline = this.now() + timeoutMs;

    while (this.now() < deadline) {
      await this.sleep(Math.min(this.pollingIntervalMs, Math.max(0, deadline - this.now())));
      const result = await this.requestJson(`${V1_BASE_URL}/res.php`, this.v1Form({
        key: this.apiKey,
        action: "get",
        id: taskId,
        json: 1,
      }));
      if (result.status === 0 && result.request === "CAPCHA_NOT_READY") continue;
      const token = this.assertV1Success(result);
      return { taskId, token };
    }
    throw new TwoCaptchaError("2Captcha did not solve the challenge before the timeout", "CAPTCHA_TIMEOUT");
  }
}
