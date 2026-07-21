import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChallenge,
  extractRecaptchaExecuteCandidates,
  isProtectedChallengeFrameUrl,
} from "../dist/challenge.js";

const evidence = (overrides = {}) => ({
  title: "Example",
  url: "https://example.com/form",
  bodyText: "Example form",
  frameUrls: ["https://example.com/form"],
  tokenPresent: false,
  userAgent: "TestAgent/1.0",
  candidates: [],
  ...overrides,
});

test("classifyChallenge returns none for a normal page", () => {
  const result = classifyChallenge(evidence());
  assert.equal(result.detection.present, false);
  assert.equal(result.detection.provider, "none");
  assert.equal(result.target, undefined);
});

test("classifyChallenge creates an hCaptcha target", () => {
  const result = classifyChallenge(evidence({
    candidates: [{ provider: "hcaptcha", siteKey: "h-site-key", invisible: true }],
  }));
  assert.equal(result.detection.kind, "hcaptcha");
  assert.equal(result.detection.canSolve, true);
  assert.equal(result.target.siteKey, "h-site-key");
  assert.equal(result.target.pageUrl, "https://example.com/form");
});

test("classifyChallenge preserves reCAPTCHA v3 enterprise metadata", () => {
  const result = classifyChallenge(evidence({
    candidates: [{
      provider: "recaptcha",
      siteKey: "recaptcha-key",
      version: "v3",
      action: "login",
      enterprise: true,
    }],
  }));
  assert.equal(result.detection.kind, "recaptcha_v3");
  assert.equal(result.detection.enterprise, true);
  assert.equal(result.target.action, "login");
});

test("explicit reCAPTCHA v3 evidence outranks its invisible anchor frame", () => {
  const result = classifyChallenge(evidence({
    candidates: [
      { provider: "recaptcha", siteKey: "same-key", version: "v2", invisible: true },
      { provider: "recaptcha", siteKey: "same-key", version: "v3" },
    ],
  }));
  assert.equal(result.detection.kind, "recaptcha_v3");
  assert.equal(result.target.version, "v3");
});

test("extractRecaptchaExecuteCandidates accepts only active site keys", () => {
  const candidates = extractRecaptchaExecuteCandidates([
    `window.grecaptcha.ready(() => grecaptcha.execute('active-key', {action: 'checkout'}).then(function(token) { window.verifyCaptcha(token); }));`,
    `grecaptcha.enterprise.execute('other-key', {action: 'login'});`,
  ], ["active-key"]);
  assert.deepEqual(candidates, [{
    provider: "recaptcha",
    siteKey: "active-key",
    version: "v3",
    action: "checkout",
    callbackName: "verifyCaptcha",
  }]);
});

test("classifyChallenge identifies a managed Turnstile challenge", () => {
  const result = classifyChallenge(evidence({
    title: "Just a moment...",
    bodyText: "Verifying you are human",
    frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0"],
    candidates: [{
      provider: "turnstile",
      siteKey: "0x4AAAA",
      action: "managed",
      cData: "data",
      chlPageData: "page-data",
    }],
  }));
  assert.equal(result.detection.kind, "cloudflare_managed");
  assert.equal(result.detection.hasData, true);
  assert.equal(result.detection.hasPageData, true);
});

test("classifyChallenge reports a missing site key without pretending it is solvable", () => {
  const result = classifyChallenge(evidence({
    frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/"],
  }));
  assert.equal(result.detection.present, true);
  assert.equal(result.detection.canSolve, false);
  assert.equal(result.detection.reason, "missing_site_key");
});

test("an existing token marks the page as clear", () => {
  const result = classifyChallenge(evidence({
    tokenPresent: true,
    candidates: [{ provider: "turnstile", siteKey: "0x4AAAA" }],
  }));
  assert.equal(result.detection.present, false);
  assert.equal(result.detection.tokenPresent, true);
});

test("known captcha frames are protected from direct DOM access", () => {
  assert.equal(isProtectedChallengeFrameUrl("https://challenges.cloudflare.com/widget"), true);
  assert.equal(isProtectedChallengeFrameUrl("https://www.google.com/recaptcha/api2/anchor"), true);
  assert.equal(isProtectedChallengeFrameUrl("https://newassets.hcaptcha.com/captcha/v1/abc"), true);
  assert.equal(isProtectedChallengeFrameUrl("https://example.com/frame"), false);
});
