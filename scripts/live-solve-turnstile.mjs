/**
 * Live integration smoke for framed-widget coordinate interaction.
 * Not part of npm test (network + browser + environment-dependent pages).
 *
 * Usage: node scripts/live-solve-turnstile.mjs [runs=3]
 */
import { ChromiumFishBrowser } from "../dist/browser.js";

const URL = process.env.LIVE_TEST_URL
  || "https://2captcha.com/demo/cloudflare-turnstile-challenge";
const runs = Math.max(1, Number(process.argv[2] || 3));
const chromePath = process.env.CHROME_BIN
  || "/root/.cache/chromiumfish/149.0.7827.115/linux-x64/chromiumfish-linux-x64/chrome";

const results = [];

for (let i = 1; i <= runs; i += 1) {
  const browser = new ChromiumFishBrowser({
    headless: true,
    windowSize: [1920, 1080],
    allowEval: false,
    allowNativeAgent: false,
    maxTextChars: 50_000,
    allowedHosts: [],
    chromePath,
    personaSeed: `frame-widget-test-${i}-${Date.now()}`,
  });
  const started = Date.now();
  try {
    console.log(`\n=== run ${i}/${runs} ===`);
    await browser.navigate(URL);
    await new Promise((r) => setTimeout(r, 2000));
    const detected = await browser.detectChallenge();
    console.log("detect:", JSON.stringify({
      present: detected.present,
      kind: detected.kind,
      title: detected.title,
      widget: detected.widget,
    }));
    const solved = await browser.solveTurnstile({ timeoutMs: 60_000, maxClicks: 14 });
    console.log("solve:", JSON.stringify({
      ok: solved.ok,
      method: solved.method,
      attempts: solved.attempts,
      elapsedMs: solved.elapsedMs,
      title: solved.title,
      bodySnippet: solved.bodySnippet?.slice(0, 160),
      error: solved.error,
      clicks: solved.clicks?.length,
    }));
    results.push({
      run: i,
      ok: solved.ok,
      method: solved.method,
      attempts: solved.attempts,
      elapsedMs: solved.elapsedMs,
      title: solved.title,
      bodySnippet: solved.bodySnippet?.slice(0, 120),
      detectPresent: detected.present,
      ms: Date.now() - started,
    });
  } catch (error) {
    console.error("run failed:", error);
    results.push({ run: i, ok: false, error: String(error), ms: Date.now() - started });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log("\n=== summary ===");
console.log(JSON.stringify({ passed, total: runs, rate: `${passed}/${runs}`, results }, null, 2));
process.exitCode = passed > 0 ? 0 : 1;
