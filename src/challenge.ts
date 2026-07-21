/** 与浏览器和求解服务解耦的验证码契约。 */

export type ChallengeProvider = "none" | "recaptcha" | "hcaptcha" | "turnstile" | "unknown";

export type ChallengeKind =
  | "none"
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "recaptcha_enterprise"
  | "hcaptcha"
  | "turnstile"
  | "cloudflare_managed"
  | "unknown";

export type ChallengeSolveMethod =
  | "already_clear"
  | "2captcha"
  | "not_found"
  | "unsupported"
  | "busy"
  | "timeout"
  | "error";

export interface ChallengeCandidate {
  provider: Exclude<ChallengeProvider, "none" | "unknown">;
  siteKey?: string;
  version?: "v2" | "v3";
  action?: string;
  enterprise?: boolean;
  invisible?: boolean;
  cData?: string;
  chlPageData?: string;
  callbackName?: string;
  widgetId?: string;
}

export interface ChallengeTarget extends ChallengeCandidate {
  kind: Exclude<ChallengeKind, "none" | "unknown">;
  pageUrl: string;
  userAgent: string;
}

export interface ChallengeEvidence {
  title: string;
  url: string;
  bodyText: string;
  frameUrls: string[];
  tokenPresent: boolean;
  userAgent: string;
  candidates: ChallengeCandidate[];
}

export interface ChallengeDetection {
  present: boolean;
  kind: ChallengeKind;
  provider: ChallengeProvider;
  canSolve: boolean;
  title: string;
  url: string;
  bodySnippet: string;
  tokenPresent: boolean;
  siteKey?: string;
  action?: string;
  enterprise?: boolean;
  invisible?: boolean;
  hasData?: boolean;
  hasPageData?: boolean;
  reason?: "missing_site_key" | "unsupported_type";
  frames: Array<{ url: string }>;
}

export interface ChallengeInspection {
  detection: ChallengeDetection;
  target?: ChallengeTarget;
}

export interface ChallengeSolveOptions {
  timeoutMs?: number;
  action?: string;
  minScore?: number;
}

export interface ChallengeSolveResult {
  ok: boolean;
  method: ChallengeSolveMethod;
  provider: ChallengeProvider;
  kind: ChallengeKind;
  elapsedMs: number;
  applied: boolean;
  callbackInvoked?: boolean;
  fieldsUpdated?: number;
  tokenPresent: boolean;
  title: string;
  url: string;
  bodySnippet: string;
  taskId?: string;
  cost?: string;
  solveCount?: number;
  errorCode?: string;
  error?: string;
}

export interface CaptchaSolution {
  taskId: string;
  token: string;
  cost?: string;
  solveCount?: number;
}

export interface CaptchaSolver {
  solve(
    target: ChallengeTarget,
    options: Required<Pick<ChallengeSolveOptions, "timeoutMs">> & Pick<ChallengeSolveOptions, "minScore">,
  ): Promise<CaptchaSolution>;
}

const CLOUDFLARE_FRAME_RE = /challenges\.cloudflare\.com/i;
const RECAPTCHA_FRAME_RE = /(?:google\.com|recaptcha\.net)\/recaptcha\/|gstatic\.com\/recaptcha\//i;
const HCAPTCHA_FRAME_RE = /(?:^|\.)hcaptcha\.com\//i;
const INTERSTITIAL_TITLE_RE = /just a moment|checking your browser|performing security verification/i;
const INTERSTITIAL_BODY_RE =
  /verify(?:ing)? you are human|performing security verification|checking your browser before accessing|needs to review the security|this may take a few seconds/i;

export function isCloudflareFrameUrl(url: string): boolean {
  return CLOUDFLARE_FRAME_RE.test(url);
}

export function isProtectedChallengeFrameUrl(url: string): boolean {
  return CLOUDFLARE_FRAME_RE.test(url) || RECAPTCHA_FRAME_RE.test(url) || HCAPTCHA_FRAME_RE.test(url);
}

export function snippet(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

export function extractRecaptchaExecuteCandidates(
  scriptTexts: string[],
  activeSiteKeys: string[],
): ChallengeCandidate[] {
  const active = new Set(activeSiteKeys.filter(Boolean));
  if (active.size === 0) return [];
  const candidates: ChallengeCandidate[] = [];
  const executePattern = /(?:window\.)?grecaptcha(\.enterprise)?\.execute\s*\(\s*(["'`])([^"'`]+)\2\s*,\s*\{([\s\S]{0,2000}?)\}\s*\)/g;
  const actionPattern = /\baction\s*:\s*(["'`])([^"'`]+)\1/;
  for (const text of scriptTexts) {
    executePattern.lastIndex = 0;
    for (let match = executePattern.exec(text); match; match = executePattern.exec(text)) {
      const siteKey = match[3];
      if (!siteKey || !active.has(siteKey)) continue;
      const actionMatch = actionPattern.exec(match[4] ?? "");
      const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 2_000);
      const directThen = /\.then\s*\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)/.exec(tail);
      const callbackCalls = Array.from(tail.matchAll(
        /(?:window\.)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(\s*(?:token|response)\s*\)/g,
      ));
      const callbackName = directThen?.[1] ?? callbackCalls
        .map((candidate) => candidate[1])
        .find((name) => name && !["function", "then", "resolve", "reject"].includes(name));
      candidates.push({
        provider: "recaptcha",
        siteKey,
        version: "v3",
        ...(match[1] ? { enterprise: true } : {}),
        ...(actionMatch?.[2] ? { action: actionMatch[2] } : {}),
        ...(callbackName ? { callbackName } : {}),
      });
    }
  }
  return candidates;
}

function candidateKind(candidate: ChallengeCandidate, managed: boolean): ChallengeTarget["kind"] {
  if (candidate.provider === "hcaptcha") return "hcaptcha";
  if (candidate.provider === "turnstile") return managed ? "cloudflare_managed" : "turnstile";
  if (candidate.version === "v3") return "recaptcha_v3";
  return candidate.enterprise ? "recaptcha_enterprise" : "recaptcha_v2";
}

function candidateRank(candidate: ChallengeCandidate): number {
  const hasKey = candidate.siteKey ? 10 : 0;
  const providerRank = candidate.provider === "turnstile" ? 3 : candidate.provider === "hcaptcha" ? 2 : 1;
  const capturedData = candidate.cData || candidate.chlPageData || candidate.action ? 2 : 0;
  const explicitVersion = candidate.version === "v3" ? 1 : 0;
  return hasKey + providerRank + capturedData + explicitVersion;
}

export function classifyChallenge(evidence: ChallengeEvidence): ChallengeInspection {
  const frames = evidence.frameUrls.map((url) => ({ url }));
  const base = {
    title: evidence.title,
    url: evidence.url,
    bodySnippet: snippet(evidence.bodyText),
    tokenPresent: evidence.tokenPresent,
    frames,
  };

  if (evidence.tokenPresent) {
    return {
      detection: {
        ...base,
        present: false,
        kind: "none",
        provider: "none",
        canSolve: false,
      },
    };
  }

  const hasCloudflareFrame = evidence.frameUrls.some(isCloudflareFrameUrl);
  const managed = INTERSTITIAL_TITLE_RE.test(evidence.title)
    || INTERSTITIAL_BODY_RE.test(evidence.bodyText)
    || /__cf_chl|cf-browser-verification|cdn-cgi\/challenge-platform/i.test(evidence.url);
  const candidates = [...evidence.candidates].sort((a, b) => candidateRank(b) - candidateRank(a));
  const candidate = candidates[0];

  if (!candidate && !hasCloudflareFrame && !managed) {
    return {
      detection: {
        ...base,
        present: false,
        kind: "none",
        provider: "none",
        canSolve: false,
      },
    };
  }

  if (!candidate) {
    return {
      detection: {
        ...base,
        present: true,
        kind: "cloudflare_managed",
        provider: "turnstile",
        canSolve: false,
        reason: "missing_site_key",
      },
    };
  }

  const kind = candidateKind(candidate, managed && candidate.provider === "turnstile");
  const target = candidate.siteKey
    ? {
        ...candidate,
        siteKey: candidate.siteKey,
        kind,
        pageUrl: evidence.url,
        userAgent: evidence.userAgent,
      }
    : undefined;

  return {
    detection: {
      ...base,
      present: true,
      kind,
      provider: candidate.provider,
      canSolve: target !== undefined,
      ...(candidate.siteKey ? { siteKey: candidate.siteKey } : {}),
      ...(candidate.action ? { action: candidate.action } : {}),
      ...(candidate.enterprise !== undefined ? { enterprise: candidate.enterprise } : {}),
      ...(candidate.invisible !== undefined ? { invisible: candidate.invisible } : {}),
      ...(candidate.cData ? { hasData: true } : {}),
      ...(candidate.chlPageData ? { hasPageData: true } : {}),
      ...(!target ? { reason: "missing_site_key" as const } : {}),
    },
    ...(target ? { target } : {}),
  };
}
