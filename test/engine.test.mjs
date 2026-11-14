import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LIMITS,
  RUN_STATUS,
  STEP_STATUS,
  createOfflineRun,
  requestStop,
  runOfflineToTerminal,
  stepOfflineRun,
  validateAgentResult,
  validateLimits,
} from "../lib/swarm/index.mjs";

const base = Object.freeze({
  objective: "Test the bounded workflow",
  criteria: "Every transition is validated",
  scenario: "success",
  limits: DEFAULT_LIMITS,
});

function run(overrides = {}) {
  return runOfflineToTerminal({ ...base, ...overrides });
}

test("successful four-role path completes", () => {
  const state = run();
  assert.equal(state.status, RUN_STATUS.COMPLETE);
  assert.deepEqual(state.trace.map((entry) => entry.agent), ["researcher", "architect", "coder", "reviewer"]);
  assert.equal(state.calls, 4);
  assert.equal(state.handoffs, 3);
});

test("one bounded reviewer rework completes at the ceilings", () => {
  const state = run({ scenario: "rework" });
  assert.equal(state.status, RUN_STATUS.COMPLETE);
  assert.equal(state.calls, 6);
  assert.equal(state.handoffs, 5);
  assert.equal(state.reservedTokens, 7_500);
});

test("research loop stops at the visit limit", () => {
  assert.equal(run({ scenario: "loop" }).status, RUN_STATUS.VISIT_LIMIT);
});

test("researcher cannot complete the run", () => {
  const state = run({ scenario: "invalid" });
  assert.equal(state.status, RUN_STATUS.INVALID_HANDOFF);
  assert.equal(state.records.length, 0);
  assert.equal(state.reservedTokens, 1_250);
});

test("provider ambiguity retains reservation and stops without retry", () => {
  const state = run({ scenario: "failure" });
  assert.equal(state.status, RUN_STATUS.UNKNOWN_OUTCOME);
  assert.equal(state.calls, 3);
  assert.equal(state.reservedTokens, 3_750);
  assert.equal(state.trace.at(-1).status, STEP_STATUS.UNKNOWN_OUTCOME);
});

test("token budget is checked before dispatch", () => {
  const state = run({ limits: { ...DEFAULT_LIMITS, tokenBudget: 1_249 } });
  assert.equal(state.status, RUN_STATUS.TOKEN_LIMIT);
  assert.equal(state.calls, 0);
  assert.equal(state.trace.length, 0);
});

test("call limit stops the next dispatch", () => {
  const state = run({ limits: { ...DEFAULT_LIMITS, calls: 1 } });
  assert.equal(state.status, RUN_STATUS.CALL_LIMIT);
  assert.equal(state.calls, 1);
});

test("handoff limit distinguishes committed result from dispatched handoff", () => {
  const state = run({ limits: { ...DEFAULT_LIMITS, handoffs: 0 } });
  assert.equal(state.status, RUN_STATUS.HANDOFF_LIMIT);
  assert.equal(state.calls, 1);
  assert.equal(state.records.length, 1);
  assert.equal(state.trace[0].resultCommitted, true);
  assert.equal(state.trace[0].handoffDispatched, false);
  assert.equal(state.trace[0].status, STEP_STATUS.HANDOFF_BLOCKED);
});

test("input cap stops before reservation", () => {
  const state = run({ limits: { ...DEFAULT_LIMITS, inputTokenCap: 249 } });
  assert.equal(state.status, RUN_STATUS.INPUT_LIMIT);
  assert.equal(state.reservedTokens, 0);
});

test("output cap stops before reservation", () => {
  const state = run({ limits: { ...DEFAULT_LIMITS, outputTokenCap: 99 } });
  assert.equal(state.status, RUN_STATUS.OUTPUT_LIMIT);
  assert.equal(state.reservedTokens, 0);
});

test("whole-run timeout stops before dispatch", () => {
  const state = createOfflineRun(base, 0);
  const timedOut = stepOfflineRun(state, DEFAULT_LIMITS.runTimeoutMs);
  assert.equal(timedOut.status, RUN_STATUS.RUN_TIMEOUT);
  assert.equal(timedOut.calls, 0);
});

test("user stop is monotonic", () => {
  const state = createOfflineRun(base, 0);
  const stopped = requestStop(state, 1);
  const afterStep = stepOfflineRun(stopped, 2);
  assert.equal(afterStep.status, RUN_STATUS.USER_STOPPED);
  assert.equal(afterStep.calls, 0);
});

test("step operation does not mutate its input", () => {
  const state = createOfflineRun(base, 0);
  const before = structuredClone(state);
  const next = stepOfflineRun(state, 1);
  assert.deepEqual(state, before);
  assert.notDeepEqual(next, state);
});

test("limits reject browser expansion and non-integers", () => {
  assert.ok(validateLimits({ ...DEFAULT_LIMITS, calls: 7 }).length);
  assert.ok(validateLimits({ ...DEFAULT_LIMITS, calls: 1.5 }).length);
  assert.ok(validateLimits({ ...DEFAULT_LIMITS, extra: 1 }).length);
});

test("configuration requires an objective and criteria", () => {
  assert.throws(() => createOfflineRun({ ...base, objective: "" }), /objective/i);
  assert.throws(() => createOfflineRun({ ...base, criteria: "" }), /criteria/i);
});

test("agent result validation rejects extra fields and invalid usage", () => {
  assert.ok(validateAgentResult({ next: "architect", record: "ok", outputTokens: 10, extra: true }, "researcher", 100).length);
  assert.ok(validateAgentResult({ next: "architect", record: "ok", outputTokens: -1 }, "researcher", 100).length);
  assert.ok(validateAgentResult({ next: "architect", record: "ok", outputTokens: true }, "researcher", 100).length);
});
