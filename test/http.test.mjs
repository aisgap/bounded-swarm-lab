import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { z } from "zod";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {};", shortCircuit: true };
    }
    if (specifier === "@/app/chatgpt-auth") {
      return {
        url: "data:text/javascript,export async function getChatGPTUser(){return null;}",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const http = await import("../lib/server/http.ts");

function writeRequest(headers = {}, body = "{}") {
  return new Request("https://bounded.example/api/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://bounded.example",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body,
  });
}

test("write requests require JSON and a matching explicit origin", () => {
  assert.doesNotThrow(() => http.assertTrustedWrite(writeRequest()));
  for (const [headers, code] of [
    [{ origin: "" }, "ORIGIN_REQUIRED"],
    [{ origin: "https://attacker.example" }, "ORIGIN_MISMATCH"],
    [{ "sec-fetch-site": "cross-site" }, "CROSS_SITE_WRITE_BLOCKED"],
    [{ "content-type": "text/plain" }, "JSON_REQUIRED"],
  ]) {
    assert.throws(
      () => http.assertTrustedWrite(writeRequest(headers)),
      (error) => error.code === code,
    );
  }
});

test("JSON parsing validates schema and streams with a hard byte ceiling", async () => {
  const schema = z.object({ id: z.string().min(1) }).strict();
  assert.deepEqual(
    await http.parseJson(writeRequest({}, JSON.stringify({ id: "safe" })), schema),
    { id: "safe" },
  );
  await assert.rejects(
    http.parseJson(writeRequest({}, JSON.stringify({ id: "safe", extra: true })), schema),
    (error) => error.code === "INVALID_REQUEST",
  );
  await assert.rejects(
    http.parseJson(writeRequest({}, `{"id":"${"x".repeat(70_000)}"}`), schema),
    (error) => error.code === "REQUEST_TOO_LARGE",
  );
});

test("an unauthenticated API request fails closed", async () => {
  await assert.rejects(
    http.requireApiUser(),
    (error) => error.status === 401 && error.code === "AUTH_REQUIRED",
  );
});
