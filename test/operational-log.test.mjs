import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOperationalEventSafe,
  buildOperationalEvent,
} from "../lib/swarm/index.mjs";

test("operational event keeps only allowlisted scalar metadata", () => {
  const event = buildOperationalEvent({
    event: "step_committed",
    runId: "run_123",
    stepId: "step_1",
    status: "COMMITTED",
    latencyMs: 400,
    actualMicrousd: 16_000,
    objective: "confidential objective",
    prompt: "confidential prompt",
    record: "confidential result",
    email: "person@example.com",
    apiKey: "never-log-this",
  });
  assert.deepEqual(event, {
    event: "step_committed",
    runId: "run_123",
    stepId: "step_1",
    status: "COMMITTED",
    actualMicrousd: 16_000,
    latencyMs: 400,
  });
  assert.equal(assertOperationalEventSafe(event), true);
  const serialized = JSON.stringify(event);
  for (const forbidden of ["confidential", "example.com", "never-log-this"] ) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("operational event requires a named event", () => {
  assert.throws(() => buildOperationalEvent({ runId: "run_123" }), /event is required/i);
});

test("safety assertion rejects unapproved fields", () => {
  assert.throws(() => assertOperationalEventSafe({ event: "x", prompt: "secret" }), /not allowed/i);
});
