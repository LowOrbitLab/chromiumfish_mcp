/** Helpers for interstitial / cross-origin framed challenge widgets (no Playwright imports). */

export type ChallengeKind = "none" | "interstitial" | "turnstile" | "managed" | "unknown";

export interface WidgetBox {
  x: number;
  y: number;
  width: number;
  height: number;
  frameUrl: string;
}

export interface ChallengeDetection {
  present: boolean;
  kind: ChallengeKind;
  title: string;
  url: string;
  bodySnippet: string;
  widget?: WidgetBox;
  frames: Array<{ url: string }>;
}

export interface SolveTurnstileResult {
  ok: boolean;
  method: "already_clear" | "click" | "not_found" | "timeout";
  attempts: number;
  elapsedMs: number;
  title: string;
  url: string;
  bodySnippet: string;
  widget?: WidgetBox;
  clicks: Array<{ x: number; y: number }>;
  error?: string;
}

const CF_FRAME_RE = /challenges\.cloudflare\.com|turnstile/i;
const INTERSTITIAL_TITLE_RE = /just a moment|checking your browser|performing security verification/i;
const INTERSTITIAL_BODY_RE =
  /verify you are human|performing security verification|checking your browser before accessing|needs to review the security/i;
const TURNSTILE_BODY_RE = /verify you are human|cf-turnstile|turnstile/i;

export function isCloudflareFrameUrl(url: string): boolean {
  return CF_FRAME_RE.test(url);
}

export function classifyChallenge(input: {
  title: string;
  url: string;
  bodyText: string;
  frameUrls: string[];
}): { present: boolean; kind: ChallengeKind } {
  const hasCfFrame = input.frameUrls.some((u) => isCloudflareFrameUrl(u));
  const titleHit = INTERSTITIAL_TITLE_RE.test(input.title);
  const bodyHit = INTERSTITIAL_BODY_RE.test(input.bodyText);
  const urlHit = /__cf_chl|cf-browser-verification|cdn-cgi\/challenge/i.test(input.url);
  const turnstileHit = TURNSTILE_BODY_RE.test(input.bodyText) || input.frameUrls.some((u) => /turnstile/i.test(u));

  if (!hasCfFrame && !titleHit && !bodyHit && !urlHit) {
    return { present: false, kind: "none" };
  }

  if (titleHit || urlHit) {
    // Managed / interstitial gate in front of the real page.
    if (turnstileHit || hasCfFrame) return { present: true, kind: "managed" };
    return { present: true, kind: "interstitial" };
  }

  if (turnstileHit || hasCfFrame) return { present: true, kind: "turnstile" };
  return { present: true, kind: "unknown" };
}

export function snippet(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

/**
 * Checkbox sits on the left of the 300x65 Turnstile widget.
 * Returns page-coordinate click candidates (deterministic order, small jitter applied by caller).
 */
export function checkboxClickCandidates(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Array<{ x: number; y: number }> {
  const cy = box.y + box.height / 2;
  const xs = [40, 28, 36, 44, 32, 48, 24, 52, 20];
  const ys = [0, -2, 2, -4, 3, 0, 1, -1, 0];
  return xs.map((dx, i) => ({
    x: box.x + dx,
    y: cy + (ys[i] ?? 0),
  }));
}

/** Warm-up path points near the widget before the real clicks. */
export function warmUpPath(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Array<{ x: number; y: number }> {
  return [
    { x: Math.max(8, box.x - 120), y: Math.max(8, box.y - 80) },
    { x: box.x + box.width * 0.7, y: box.y + box.height + 40 },
    { x: box.x + 10, y: box.y - 20 },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  ];
}

export function looksCleared(input: {
  title: string;
  url: string;
  bodyText: string;
  hadChallenge: boolean;
}): boolean {
  if (!input.hadChallenge) return true;
  if (INTERSTITIAL_TITLE_RE.test(input.title)) return false;
  // Playwright/Chromium interim navigation titles are not clearance.
  if (/^loading\b/i.test(input.title.trim())) return false;
  if (/__cf_chl_rt_tk=|cf-browser-verification/i.test(input.url) && INTERSTITIAL_BODY_RE.test(input.bodyText)) {
    return false;
  }
  // Success markers used by public demos and common clearance patterns.
  if (/captcha is passed successfully|verification successful|success!/i.test(input.bodyText)) {
    return true;
  }
  // Still on the challenge interstitial copy.
  if (INTERSTITIAL_BODY_RE.test(input.bodyText)) return false;
  // Require some real page content after leaving the gate.
  const body = input.bodyText.replace(/\s+/g, " ").trim();
  if (body.length < 40) return false;
  if (!input.title.trim()) return false;
  return true;
}
