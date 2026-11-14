import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const sourceUrl = new URL("../lib/server/openai.ts", import.meta.url);
const source = (await readFile(sourceUrl, "utf8")).replace('import "server-only";', "");
const executable = stripTypeScriptTypes(source, { mode: "strip" });
const adapter = await import(`data:text/javascript;base64,${Buffer.from(executable).toString("base64")}`);
const { invokeOpenAI, PROVIDER_FAILURE_CODE } = adapter;

function baseArgs(overrides = {}) {
  return {
    apiKey: "not-a-real-test-key",
    model: "gpt-6-luna",
    role: "researcher",
    allowedNext: ["architect"],
    instructions: "Return only the bounded research record.",
    serializedState: JSON.stringify({ run: "run_safe", step: 1 }),
    maxInputTokens: 3_000,
    maxOutputTokens: 1_000,
    clientRequestId: "swarm_test_0001",
    timeoutMs: 1_000,
    ...overrides,
  };
}

function modelStep(overrides = {}) {
  return {
    next: "architect",
    record: "A bounded record.",
    findings: ["One bounded finding."],
    evidence: [{ claim: "A safe claim.", source: "An operator-provided source." }],
    uncertainty: [],
    ...overrides,
  };
}

function successPayload(overrides = {}) {
  return {
    id: "resp_safe_0001",
    status: "completed",
    service_tier: "default",
    error: null,
    incomplete_details: null,
    output: [
      { type: "reasoning", id: "rs_safe" },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(modelStep()) }],
      },
    ],
    usage: {
      input_tokens: 250,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 40 },
      total_tokens: 350,
    },
    ...overrides,
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("sends one strictly bounded Responses request and accepts a valid result", async () => {
  let calls = 0;
  let observedUrl;
  let observedInit;
  const result = await invokeOpenAI(baseArgs({
    fetchImpl: async (url, init) => {
      calls += 1;
      observedUrl = url;
      observedInit = init;
      return jsonResponse(successPayload(), {
        headers: { "x-request-id": "req_safe_0001", "openai-processing-ms": "17" },
      });
    },
  }));

  assert.equal(calls, 1);
  assert.equal(observedUrl, "https://api.openai.com/v1/responses");
  assert.equal(observedInit.method, "POST");
  assert.equal(observedInit.headers.authorization, "Bearer not-a-real-test-key");
  assert.equal(observedInit.headers["x-client-request-id"], "swarm_test_0001");
  const body = JSON.parse(observedInit.body);
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.service_tier, "default");
  assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, "none");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.max_output_tokens, 1_000);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.deepEqual(body.text.format.schema.properties.next.enum, ["architect"]);

  assert.equal(result.ok, true);
  assert.equal(result.providerRequestId, "req_safe_0001");
  assert.equal(result.providerResponseId, "resp_safe_0001");
  assert.equal(result.processingMs, 17);
  assert.deepEqual(result.usage, {
    inputTokens: 250,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 40,
    totalTokens: 350,
  });
});

test("rejects invalid bounded arguments without dispatch", async () => {
  const cases = [
    { clientRequestId: "contains a space" },
    { clientRequestId: "x".repeat(513) },
    { allowedNext: [] },
    { allowedNext: ["architect", "architect"] },
    { maxInputTokens: 3_001 },
    { maxOutputTokens: 1_001 },
    { timeoutMs: 60_001 },
    { apiKey: " secret-with-whitespace " },
    { instructions: "x".repeat(3_000) },
  ];
  for (const candidate of cases) {
    let calls = 0;
    const result = await invokeOpenAI(baseArgs({
      ...candidate,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not dispatch");
      },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.code, PROVIDER_FAILURE_CODE.INVALID_PROVIDER_REQUEST);
    assert.equal(calls, 0);
  }
});

test("times out as an unknown outcome and never retries", async () => {
  let calls = 0;
  const result = await invokeOpenAI(baseArgs({
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      calls += 1;
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  }));
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    ok: false,
    code: PROVIDER_FAILURE_CODE.UNKNOWN_OUTCOME,
    providerRequestId: null,
    retryAfterSeconds: null,
    outcomeUnknown: true,
  });
});

test("maps provider errors without a hidden retry", async (t) => {
  const cases = [
    [400, "invalid_request_error", "INVALID_PROVIDER_REQUEST"],
    [401, "invalid_api_key", "AUTHENTICATION_FAILED"],
    [403, "policy_denied", "PERMISSION_OR_POLICY_DENIED"],
    [404, "model_not_found", "MODEL_UNAVAILABLE"],
    [429, "project_spend_limit_exceeded", "BUDGET_STOP"],
    [429, "organization_usage_limit_exceeded", "BUDGET_STOP"],
    [429, "credit_balance_exhausted", "BILLING_STOP"],
    [429, "rate_limit_error", "RATE_LIMITED"],
    [429, "server_is_overloaded", "PROVIDER_OVERLOADED"],
    [500, "server_error", "PROVIDER_SERVER_ERROR"],
    [503, "server_is_overloaded", "PROVIDER_OVERLOADED"],
  ];
  for (const [status, providerCode, expected] of cases) {
    await t.test(`${status} ${providerCode}`, async () => {
      let calls = 0;
      const result = await invokeOpenAI(baseArgs({
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(
            { error: { code: providerCode } },
            { status, headers: { "x-request-id": "req_error", "retry-after": "2.1" } },
          );
        },
      }));
      assert.equal(calls, 1);
      assert.equal(result.ok, false);
      assert.equal(result.code, expected);
      assert.equal(result.providerRequestId, "req_error");
      assert.equal(result.retryAfterSeconds, 3);
      assert.equal(result.outcomeUnknown, false);
    });
  }
});

test("treats refusal, incomplete output, invalid schema, and missing usage as terminal", async (t) => {
  const refusal = successPayload({
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "refusal", refusal: "Cannot comply." }],
    }],
  });
  const incomplete = successPayload({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } });
  const invalid = successPayload({
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(modelStep({ next: "reviewer" })) }],
    }],
  });
  const missingUsage = successPayload({ usage: undefined });
  const cacheWrite = successPayload({
    usage: {
      input_tokens: 250,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 10 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 350,
    },
  });
  const cachedRead = successPayload({
    usage: {
      input_tokens: 250,
      input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: 350,
    },
  });
  const unexpectedTier = successPayload({ service_tier: "priority" });
  for (const [name, payload, expected] of [
    ["refusal", refusal, "REFUSED"],
    ["incomplete", incomplete, "INCOMPLETE_RESPONSE"],
    ["invalid handoff", invalid, "INVALID_RESPONSE"],
    ["missing usage", missingUsage, "USAGE_UNKNOWN"],
    ["unpriced cache write", cacheWrite, "USAGE_UNKNOWN"],
    ["unexpected cached read", cachedRead, "USAGE_UNKNOWN"],
    ["unexpected service tier", unexpectedTier, "USAGE_UNKNOWN"],
  ]) {
    await t.test(name, async () => {
      const result = await invokeOpenAI(baseArgs({ fetchImpl: async () => jsonResponse(payload) }));
      assert.equal(result.ok, false);
      assert.equal(result.code, expected);
      assert.equal(result.outcomeUnknown, false);
    });
  }
});

test("rejects impossible usage accounting without double-counting reasoning tokens", async () => {
  const result = await invokeOpenAI(baseArgs({
    fetchImpl: async () => jsonResponse(successPayload({
      usage: {
        input_tokens: 250,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 100,
        output_tokens_details: { reasoning_tokens: 101 },
        total_tokens: 350,
      },
    })),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PROVIDER_FAILURE_CODE.ACCOUNTING_MISMATCH);
});

test("caps provider response bytes before parsing", async () => {
  const result = await invokeOpenAI(baseArgs({
    fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1), { status: 200 }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PROVIDER_FAILURE_CODE.USAGE_UNKNOWN);
});
