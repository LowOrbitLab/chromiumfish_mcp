/** Helpers for interstitial / cross-origin framed challenge widgets (no Playwright imports). */

export type ChallengeKind = "none" | "interstitial" | "turnstile" | "managed" | "unknown";

/** Best-effort widget interaction state for text-only agents. */
export type WidgetState = "absent" | "checkbox" | "verifying" | "success" | "unknown";

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
  /** Refined state when a framed widget or token field is observable. */
  widgetState: WidgetState;
  title: string;
  url: string;
  bodySnippet: string;
  /** True when a non-empty cf-turnstile-response (or similar) token is present. */
  tokenPresent: boolean;
  widget?: WidgetBox;
  frames: Array<{ url: string }>;
}

export interface SolveTurnstileResult {
  ok: boolean;
  method: "already_clear" | "click" | "not_found" | "timeout" | "busy";
  attempts: number;
  elapsedMs: number;
  title: string;
  url: string;
  bodySnippet: string;
  widgetState: WidgetState;
  tokenPresent: boolean;
  widget?: WidgetBox;
  clicks: Array<{ x: number; y: number }>;
  /** Machine-readable failure detail when ok is false. */
  reason?: "not_found" | "stuck_verifying" | "timeout" | "busy";
  error?: string;
}

/** Host used by Cloudflare challenge / Turnstile frames. */
const CF_CHALLENGE_HOST_RE = /challenges\.cloudflare\.com/i;
const INTERSTITIAL_TITLE_RE = /just a moment|checking your browser|performing security verification/i;
const INTERSTITIAL_BODY_RE =
  /verify(?:ing)? you are human|performing security verification|checking your browser before accessing|needs to review the security|this may take a few seconds/i;
/** Post-click verifying copy on managed interstitials. */
export const VERIFYING_BODY_RE =
  /verifying you are human|this may take a few seconds|checking your browser/i;
/** Strong success markers on destination pages (not marketing copy alone). */
const STRONG_SUCCESS_BODY_RE = /captcha is passed successfully|verification successful/i;

export function isCloudflareFrameUrl(url: string): boolean {
  return CF_CHALLENGE_HOST_RE.test(url);
}

export function snippet(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

/**
 * Classify page-level challenge presence.
 * Prefer real challenge frames over body keywords (docs pages often mention "turnstile").
 */
export function classifyChallenge(input: {
  title: string;
  url: string;
  bodyText: string;
  frameUrls: string[];
  tokenPresent?: boolean;
  widgetState?: WidgetState;
}): { present: boolean; kind: ChallengeKind } {
  if (input.tokenPresent || input.widgetState === "success") {
    return { present: false, kind: "none" };
  }

  const hasCfFrame = input.frameUrls.some((u) => isCloudflareFrameUrl(u));
  const titleHit = INTERSTITIAL_TITLE_RE.test(input.title);
  const bodyHit = INTERSTITIAL_BODY_RE.test(input.bodyText);
  const urlHit = /__cf_chl|cf-browser-verification|cdn-cgi\/challenge-platform/i.test(input.url);

  // Docs / marketing pages that only mention Turnstile in copy should not trigger.
  if (!hasCfFrame && !titleHit && !bodyHit && !urlHit) {
    return { present: false, kind: "none" };
  }

  // Body-only "turnstile" mentions without a CF frame are ignored (handled above).
  if (titleHit || urlHit) {
    if (hasCfFrame || bodyHit) return { present: true, kind: "managed" };
    return { present: true, kind: "interstitial" };
  }

  if (hasCfFrame) {
    // Embedded widget on an otherwise normal page.
    return { present: true, kind: "turnstile" };
  }

  // Interstitial copy without a mounted frame yet.
  if (bodyHit) return { present: true, kind: "interstitial" };
  return { present: false, kind: "none" };
}

/**
 * Checkbox sits on the left of the ~300x65 widget.
 * Offsets scale with box size so narrow/scaled widgets still hit the control.
 */
export function checkboxClickCandidates(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Array<{ x: number; y: number }> {
  const cy = box.y + box.height / 2;
  const base = clamp(box.width * 0.12, 18, 48);
  const deltas = [0, -8, 6, -12, 10, -4, 14, -16, 4];
  const yJitter = [0, -2, 2, -3, 3, 1, -1, 0, 2];
  return deltas.map((d, i) => ({
    x: box.x + clamp(base + d, 12, Math.max(16, box.width * 0.35)),
    y: cy + (yJitter[i] ?? 0),
  }));
}

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

export function isVerifyingPhase(input: {
  widgetState?: WidgetState;
  bodyText?: string;
  title?: string;
}): boolean {
  if (input.widgetState === "verifying") return true;
  if (input.bodyText && VERIFYING_BODY_RE.test(input.bodyText)) return true;
  if (input.title && /checking your browser|just a moment/i.test(input.title)
    && input.bodyText && /verifying|few seconds/i.test(input.bodyText)) {
    return true;
  }
  return false;
}

export function inferWidgetState(input: {
  tokenPresent: boolean;
  hasChallengeFrame: boolean;
  frameText?: string;
  /** Main-document signals only — weak alone for embedded widgets. */
  mainBodyText?: string;
}): WidgetState {
  if (input.tokenPresent) return "success";
  if (!input.hasChallengeFrame) {
    // Managed interstitial may drop the frame while still verifying on the main document.
    if (input.mainBodyText && VERIFYING_BODY_RE.test(input.mainBodyText)) return "verifying";
    return "absent";
  }

  const frame = (input.frameText ?? "").toLowerCase();
  if (/success/.test(frame)) return "success";
  if (/verifying|checking|spin|this may take a few seconds/.test(frame)) return "verifying";
  if (/verify you are human|verify/.test(frame)) return "checkbox";

  // Frame present but opaque (closed shadow / empty accessible text).
  if (input.mainBodyText && VERIFYING_BODY_RE.test(input.mainBodyText)) return "verifying";
  return "unknown";
}

/**
 * Whether the challenge flow is done.
 * Embedded widgets require token or frame-level success — main body alone is not enough.
 */
export function looksCleared(input: {
  title: string;
  url: string;
  bodyText: string;
  hadChallenge: boolean;
  kind?: ChallengeKind;
  tokenPresent?: boolean;
  widgetState?: WidgetState;
  hasChallengeFrame?: boolean;
}): boolean {
  if (!input.hadChallenge) return true;

  if (input.tokenPresent || input.widgetState === "success") return true;

  if (INTERSTITIAL_TITLE_RE.test(input.title)) return false;
  if (/^loading\b/i.test(input.title.trim())) return false;

  const kind = input.kind ?? "unknown";
  const embedded = kind === "turnstile";

  // Embedded Turnstile: never trust main-document "looks normal".
  if (embedded) {
    if (input.widgetState === "checkbox" || input.widgetState === "verifying") return false;
    if (input.hasChallengeFrame && !input.tokenPresent) return false;
    return false;
  }

  // Managed / full-page interstitial: leaving the gate is success.
  if (/__cf_chl_rt_tk=|cf-browser-verification/i.test(input.url) && INTERSTITIAL_BODY_RE.test(input.bodyText)) {
    return false;
  }
  if (STRONG_SUCCESS_BODY_RE.test(input.bodyText)) return true;
  if (INTERSTITIAL_BODY_RE.test(input.bodyText)) return false;

  // Still hosting a challenge frame without a token → not clear.
  if (input.hasChallengeFrame && !input.tokenPresent) return false;

  const body = input.bodyText.replace(/\s+/g, " ").trim();
  if (body.length < 40) return false;
  if (!input.title.trim()) return false;

  // Title no longer interstitial and body is real content.
  return !INTERSTITIAL_TITLE_RE.test(input.title);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
