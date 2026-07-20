import assert from "node:assert/strict";
import test from "node:test";
import {
  checkboxClickCandidates,
  classifyChallenge,
  isCloudflareFrameUrl,
  looksCleared,
  snippet,
  warmUpPath,
} from "../dist/turnstile.js";

test("isCloudflareFrameUrl matches challenge hosts", () => {
  assert.equal(
    isCloudflareFrameUrl("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0"),
    true,
  );
  assert.equal(isCloudflareFrameUrl("https://example.com/"), false);
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

test("checkboxClickCandidates target left side of widget", () => {
  const box = { x: 512, y: 304, width: 300, height: 65 };
  const points = checkboxClickCandidates(box);
  assert.ok(points.length >= 5);
  for (const point of points) {
    assert.ok(point.x >= box.x + 15 && point.x <= box.x + 60, `x=${point.x}`);
    assert.ok(Math.abs(point.y - (box.y + box.height / 2)) <= 6, `y=${point.y}`);
  }
});

test("warmUpPath stays near widget", () => {
  const box = { x: 512, y: 304, width: 300, height: 65 };
  const path = warmUpPath(box);
  assert.ok(path.length >= 3);
  assert.ok(path.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

test("looksCleared recognizes success and interstitial states", () => {
  assert.equal(
    looksCleared({
      title: "Just a moment...",
      url: "https://example.com/",
      bodyText: "Verify you are human",
      hadChallenge: true,
    }),
    false,
  );
  assert.equal(
    looksCleared({
      title: "Loading https://2captcha.com/demo/cloudflare-turnstile-challenge",
      url: "https://2captcha.com/demo/cloudflare-turnstile-challenge",
      bodyText: "",
      hadChallenge: true,
    }),
    false,
  );
  assert.equal(
    looksCleared({
      title: "Cloudflare Challenge demo",
      url: "https://2captcha.com/demo/cloudflare-turnstile-challenge",
      bodyText: "Captcha is passed successfully!",
      hadChallenge: true,
    }),
    true,
  );
  assert.equal(
    looksCleared({
      title: "Example Domain",
      url: "https://example.com/",
      bodyText: "Example Domain This domain is for use in illustrative examples in documents.",
      hadChallenge: true,
    }),
    true,
  );
});

test("snippet trims whitespace and length", () => {
  assert.equal(snippet("  a   b  "), "a b");
  assert.ok(snippet("x".repeat(400), 50).endsWith("…"));
});
