import assert from "node:assert/strict";
import test from "node:test";
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
} from "../dist/turnstile.js";

test("isCloudflareFrameUrl matches challenge hosts only", () => {
  assert.equal(
    isCloudflareFrameUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0"),
    true,
  );
  assert.equal(isCloudflareFrameUrl("https://example.com/docs/turnstile-guide"), false);
  assert.equal(isCloudflareFrameUrl("https://2captcha.com/demo/cloudflare-turnstile"), false);
});

test("classifyChallenge detects managed interstitial", () => {
  const result = classifyChallenge({
    title: "Just a moment...",
    url: "https://2captcha.com/demo/cloudflare-turnstile-challenge",
    bodyText: "Performing security verification Verify you are human",
    frameUrls: [
      "https://2captcha.com/demo/cloudflare-turnstile-challenge",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/x",
    ],
  });
  assert.equal(result.present, true);
  assert.equal(result.kind, "managed");
});

test("classifyChallenge returns none for normal pages", () => {
  const result = classifyChallenge({
    title: "Example Domain",
    url: "https://example.com/",
    bodyText: "This domain is for use in documentation examples.",
    frameUrls: ["https://example.com/"],
  });
  assert.deepEqual(result, { present: false, kind: "none" });
});

test("classifyChallenge ignores docs pages that only mention turnstile in copy", () => {
  const result = classifyChallenge({
    title: "Cloudflare Turnstile demo: Sample Form with Cloudflare Turnstile",
    url: "https://2captcha.com/demo/cloudflare-turnstile",
    bodyText:
      "How to solve Cloudflare Turnstile. Send sitekey to our API. cf-turnstile widget docs.",
    frameUrls: ["https://2captcha.com/demo/cloudflare-turnstile"],
  });
  assert.equal(result.present, false);
  assert.equal(result.kind, "none");
});

test("classifyChallenge detects embedded widget via challenge frame", () => {
  const result = classifyChallenge({
    title: "Cloudflare Turnstile demo",
    url: "https://2captcha.com/demo/cloudflare-turnstile",
    bodyText: "Cloudflare Turnstile demo page with lots of documentation copy.",
    frameUrls: [
      "https://2captcha.com/demo/cloudflare-turnstile",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/x",
    ],
  });
  assert.equal(result.present, true);
  assert.equal(result.kind, "turnstile");
});

test("classifyChallenge treats token/success as cleared", () => {
  const result = classifyChallenge({
    title: "Just a moment...",
    url: "https://example.com/",
    bodyText: "Verify you are human",
    frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/x"],
    tokenPresent: true,
  });
  assert.equal(result.present, false);
});

test("checkboxClickCandidates scale with widget width", () => {
  const box = { x: 512, y: 304, width: 300, height: 65 };
  const points = checkboxClickCandidates(box);
  assert.ok(points.length >= 5);
  for (const point of points) {
    assert.ok(point.x >= box.x + 12 && point.x <= box.x + box.width * 0.4, `x=${point.x}`);
    assert.ok(Math.abs(point.y - (box.y + box.height / 2)) <= 6, `y=${point.y}`);
  }
  const narrow = checkboxClickCandidates({ x: 10, y: 10, width: 160, height: 55 });
  assert.ok(narrow[0].x < 10 + 40);
});

test("warmUpPath stays near widget and avoids center rest", () => {
  const box = { x: 512, y: 304, width: 300, height: 65 };
  const path = warmUpPath(box);
  assert.ok(path.length >= 3);
  assert.ok(path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  // Should not park on widget center before the real checkbox click.
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const last = path[path.length - 1];
  assert.ok(Math.hypot(last.x - centerX, last.y - centerY) > 15);
});

test("initialCursorPos never returns origin", () => {
  for (let i = 0; i < 20; i += 1) {
    const p = initialCursorPos({ width: 1920, height: 1080 });
    assert.ok(p.x > 10 && p.y > 10);
    assert.ok(p.x < 1920 && p.y < 1080);
  }
});

test("inferWidgetState from token and frame text", () => {
  assert.equal(inferWidgetState({ tokenPresent: true, hasChallengeFrame: true }), "success");
  assert.equal(inferWidgetState({ tokenPresent: false, hasChallengeFrame: false }), "absent");
  assert.equal(
    inferWidgetState({ tokenPresent: false, hasChallengeFrame: true, frameText: "Verify you are human" }),
    "checkbox",
  );
  assert.equal(
    inferWidgetState({ tokenPresent: false, hasChallengeFrame: true, frameText: "Success!" }),
    "success",
  );
  assert.equal(
    inferWidgetState({ tokenPresent: false, hasChallengeFrame: true, frameText: "" }),
    "unknown",
  );
});

test("looksCleared does not trust main body for embedded turnstile", () => {
  // Docs-heavy page with unchecked embedded widget must NOT count as cleared.
  assert.equal(
    looksCleared({
      title: "Cloudflare Turnstile demo",
      url: "https://2captcha.com/demo/cloudflare-turnstile",
      bodyText:
        "This page explains how Cloudflare Turnstile is displayed and how verification works. Lots of docs content here.",
      hadChallenge: true,
      kind: "turnstile",
      tokenPresent: false,
      widgetState: "unknown",
      hasChallengeFrame: true,
    }),
    false,
  );
  assert.equal(
    looksCleared({
      title: "Cloudflare Turnstile demo",
      url: "https://2captcha.com/demo/cloudflare-turnstile",
      bodyText: "docs...",
      hadChallenge: true,
      kind: "turnstile",
      tokenPresent: true,
      widgetState: "success",
      hasChallengeFrame: true,
    }),
    true,
  );
});

test("looksCleared for managed interstitial still uses page navigation signals", () => {
  assert.equal(
    looksCleared({
      title: "Just a moment...",
      url: "https://example.com/",
      bodyText: "Verify you are human",
      hadChallenge: true,
      kind: "managed",
      tokenPresent: false,
      hasChallengeFrame: true,
    }),
    false,
  );
  assert.equal(
    looksCleared({
      title: "Loading https://example.com/",
      url: "https://example.com/",
      bodyText: "",
      hadChallenge: true,
      kind: "managed",
    }),
    false,
  );
  assert.equal(
    looksCleared({
      title: "Cloudflare Challenge demo",
      url: "https://2captcha.com/demo/cloudflare-turnstile-challenge",
      bodyText: "Captcha is passed successfully! Welcome to the destination page content.",
      hadChallenge: true,
      kind: "managed",
      tokenPresent: false,
      hasChallengeFrame: false,
    }),
    true,
  );
  assert.equal(
    looksCleared({
      title: "Example Domain",
      url: "https://example.com/",
      bodyText: "Example Domain This domain is for use in illustrative examples in documents.",
      hadChallenge: true,
      kind: "managed",
      hasChallengeFrame: false,
    }),
    true,
  );
});

test("isVerifyingPhase detects verifying copy", () => {
  assert.equal(isVerifyingPhase({ bodyText: "Verifying you are human. This may take a few seconds." }), true);
  assert.equal(isVerifyingPhase({ widgetState: "verifying" }), true);
  assert.equal(isVerifyingPhase({ bodyText: "Welcome to the app" }), false);
});

test("snippet trims whitespace and length", () => {
  assert.equal(snippet("  a   b  "), "a b");
  assert.ok(snippet("x".repeat(400), 50).endsWith("…"));
});
