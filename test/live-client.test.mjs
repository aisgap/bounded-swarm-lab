import assert from "node:assert/strict";
import test from "node:test";

import { createLiveClient, runIdFromSearch } from "../lib/swarm/live-client.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function client(overrides = {}) {
  let nextId = 0;
  return createLiveClient({
    createRequest: async (body) => ({ body }),
    stepRequest: async (runId, body) => ({ runId, body }),
    stopRequest: async (runId, body) => ({ runId, body }),
    getRequest: async (runId) => ({ run: { id: runId, status: "RUNNING" } }),
    makeId: () => `id_${++nextId}`,
    ...overrides,
  });
}

test("rapid create and step clicks dispatch once", async () => {
  const createGate = deferred();
  const stepGate = deferred();
  let creates = 0;
  let steps = 0;
  const live = client({
    createRequest: async () => {
      creates += 1;
      return createGate.promise;
    },
    stepRequest: async () => {
      steps += 1;
      return stepGate.promise;
    },
  });

  const firstCreate = live.createRun({ objective: "safe", acceptanceCriteria: "safe" });
  assert.deepEqual(await live.createRun({ objective: "safe", acceptanceCriteria: "safe" }), {
    ignored: true,
    ok: false,
  });
  assert.equal(creates, 1);
  createGate.resolve({ run: { id: "run_safe_1" } });
  assert.equal((await firstCreate).ok, true);

  const firstStep = live.stepRun("run_safe_1");
  assert.deepEqual(await live.stepRun("run_safe_1"), {
    ignored: true,
    ok: false,
    ambiguous: false,
  });
  assert.equal(steps, 1);
  stepGate.resolve({ run: { id: "run_safe_1" } });
  assert.equal((await firstStep).ok, true);
});

test("ambiguous create reuses its stable idempotency key until success", async () => {
  const bodies = [];
  let attempt = 0;
  const live = client({
    createRequest: async (body) => {
      bodies.push(body);
      attempt += 1;
      if (attempt === 1) throw new Error("response lost");
      return { run: { id: "run_safe_2" } };
    },
  });

  assert.equal((await live.createRun({ objective: "same" })).ok, false);
  assert.equal((await live.createRun({ objective: "same" })).ok, true);
  assert.equal(bodies[0].idempotencyKey, bodies[1].idempotencyKey);

  await live.createRun({ objective: "next" });
  assert.notEqual(bodies[1].idempotencyKey, bodies[2].idempotencyKey);
});

test("step ambiguity performs one GET, never retries, and locks the run", async () => {
  let steps = 0;
  let reads = 0;
  const live = client({
    stepRequest: async () => {
      steps += 1;
      throw new Error("transport lost");
    },
    getRequest: async (runId) => {
      reads += 1;
      return { run: { id: runId, status: "UNKNOWN_OUTCOME" } };
    },
  });

  const result = await live.stepRun("run_safe_3");
  assert.equal(result.ambiguous, true);
  assert.equal(result.reconciliation.run.status, "UNKNOWN_OUTCOME");
  assert.equal(steps, 1);
  assert.equal(reads, 1);

  assert.deepEqual(await live.stepRun("run_safe_3"), {
    ignored: true,
    ok: false,
    ambiguous: true,
  });
  assert.equal(steps, 1);
  assert.equal(reads, 1);
});

test("Stop remains independently available while a step is pending", async () => {
  const stepGate = deferred();
  let stops = 0;
  const live = client({
    stepRequest: async () => stepGate.promise,
    stopRequest: async (runId) => {
      stops += 1;
      return { run: { id: runId, status: "USER_STOPPED" } };
    },
  });

  const pendingStep = live.stepRun("run_safe_4");
  const stopped = await live.stopRun("run_safe_4");
  assert.equal(stopped.ok, true);
  assert.equal(stops, 1);
  stepGate.resolve({ run: { id: "run_safe_4", status: "RUNNING" } });
  assert.equal((await pendingStep).ok, true);
});

test("a new run can clear the prior run's ambiguity lock", async () => {
  let shouldFail = true;
  const live = client({
    stepRequest: async (runId) => {
      if (shouldFail) throw new Error("lost");
      return { run: { id: runId, status: "RUNNING" } };
    },
  });
  await live.stepRun("run_safe_5");
  assert.equal(live.isStepBlocked("run_safe_5"), true);
  live.resetForNewRun();
  shouldFail = false;
  assert.equal((await live.stepRun("run_safe_6")).ok, true);
});

test("run IDs recover only from the exact validated query field", () => {
  assert.equal(runIdFromSearch("?run=run_safe_7"), "run_safe_7");
  assert.equal(runIdFromSearch("run=run-safe-8&x=1"), "run-safe-8");
  assert.equal(runIdFromSearch("?run=short"), null);
  assert.equal(runIdFromSearch("?run=run.safe.9"), null);
  assert.equal(runIdFromSearch("?other=run_safe_9"), null);
  assert.equal(runIdFromSearch(null), null);
});
