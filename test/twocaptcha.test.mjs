import assert from "node:assert/strict";
import test from "node:test";
import { TwoCaptchaClient, TwoCaptchaError } from "../dist/twocaptcha.js";

const target = (overrides = {}) => ({
  provider: "recaptcha",
  kind: "recaptcha_v2",
  siteKey: "site-key",
  pageUrl: "https://example.com/form",
  userAgent: "TestAgent/1.0",
  ...overrides,
});

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("TwoCaptchaClient solves reCAPTCHA through API v2", async () => {
  const requests = [];
  const responses = [
    { errorId: 0, taskId: 123 },
    { errorId: 0, status: "processing" },
    {
      errorId: 0,
      status: "ready",
      solution: { gRecaptchaResponse: "recaptcha-token" },
      cost: "0.00299",
      solveCount: 1,
    },
  ];
  const client = new TwoCaptchaClient("test-key", {
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(responses.shift());
    },
    pollingIntervalMs: 0,
    sleep: async () => undefined,
  });

  const result = await client.solve(target(), { timeoutMs: 30_000 });
  assert.equal(result.taskId, "123");
  assert.equal(result.token, "recaptcha-token");
  assert.equal(result.cost, "0.00299");
  assert.equal(requests[0].url, "https://api.2captcha.com/createTask");
  assert.equal(requests[0].body.task.type, "RecaptchaV2TaskProxyless");
  assert.equal(requests[0].body.task.websiteKey, "site-key");
  assert.equal(requests[2].url, "https://api.2captcha.com/getTaskResult");
});

test("TwoCaptchaClient keeps reCAPTCHA v3 enterprise on the v3 task type", async () => {
  let createdTask;
  const responses = [
    { errorId: 0, taskId: 456 },
    { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "v3-token" } },
  ];
  const client = new TwoCaptchaClient("test-key", {
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.task) createdTask = request.task;
      return jsonResponse(responses.shift());
    },
    pollingIntervalMs: 0,
    sleep: async () => undefined,
  });

  await client.solve(target({
    kind: "recaptcha_v3",
    version: "v3",
    enterprise: true,
    action: "login",
  }), { timeoutMs: 30_000, minScore: 0.7 });
  assert.equal(createdTask.type, "RecaptchaV3TaskProxyless");
  assert.equal(createdTask.isEnterprise, true);
  assert.equal(createdTask.pageAction, "login");
  assert.equal(createdTask.minScore, 0.7);
});

test("TwoCaptchaClient solves hCaptcha through the supported API v1 method", async () => {
  const requests = [];
  const responses = [
    { status: 1, request: "h-task" },
    { status: 0, request: "CAPCHA_NOT_READY" },
    { status: 1, request: "hcaptcha-token" },
  ];
  const client = new TwoCaptchaClient("test-key", {
    fetchImpl: async (url, init) => {
      requests.push({ url, body: new URLSearchParams(init.body) });
      return jsonResponse(responses.shift());
    },
    pollingIntervalMs: 0,
    sleep: async () => undefined,
  });

  const result = await client.solve(target({ provider: "hcaptcha", kind: "hcaptcha" }), {
    timeoutMs: 30_000,
  });
  assert.equal(result.token, "hcaptcha-token");
  assert.equal(requests[0].url, "https://2captcha.com/in.php");
  assert.equal(requests[0].body.get("method"), "hcaptcha");
  assert.equal(requests[0].body.get("sitekey"), "site-key");
  assert.equal(requests[2].url, "https://2captcha.com/res.php");
});

test("managed Turnstile requires forwarding the browser proxy", async () => {
  const client = new TwoCaptchaClient("test-key", {
    fetchImpl: async () => {
      throw new Error("must not send");
    },
  });
  await assert.rejects(
    client.solve(target({ provider: "turnstile", kind: "cloudflare_managed" }), {
      timeoutMs: 30_000,
    }),
    (error) => error instanceof TwoCaptchaError && error.code === "PROXY_REQUIRED",
  );
});

test("proxy forwarding builds a non-proxyless Turnstile task", async () => {
  let createdTask;
  const responses = [
    { errorId: 0, taskId: 789 },
    { errorId: 0, status: "ready", solution: { token: "turnstile-token" } },
  ];
  const client = new TwoCaptchaClient("test-key", {
    proxy: {
      server: "http://127.0.0.1:8080",
      username: "alice",
      password: "secret",
    },
    forwardProxy: true,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.task) createdTask = request.task;
      return jsonResponse(responses.shift());
    },
    pollingIntervalMs: 0,
    sleep: async () => undefined,
  });

  await client.solve(target({
    provider: "turnstile",
    kind: "cloudflare_managed",
    action: "managed",
    cData: "captcha-data",
    chlPageData: "page-data",
  }), { timeoutMs: 30_000 });
  assert.equal(createdTask.type, "TurnstileTask");
  assert.equal(createdTask.proxyAddress, "127.0.0.1");
  assert.equal(createdTask.proxyLogin, "alice");
  assert.equal(createdTask.data, "captcha-data");
  assert.equal(createdTask.pagedata, "page-data");
});

test("API errors expose a stable code without echoing the API key", async () => {
  const client = new TwoCaptchaClient("top-secret", {
    fetchImpl: async () => jsonResponse({
      errorId: 1,
      errorCode: "ERROR_ZERO_BALANCE",
      errorDescription: "Account has zero balance",
    }),
  });
  await assert.rejects(
    client.solve(target(), { timeoutMs: 30_000 }),
    (error) => error instanceof TwoCaptchaError
      && error.code === "ERROR_ZERO_BALANCE"
      && !error.message.includes("top-secret"),
  );
});
