import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_RUN_STATUSES,
  buildRedactedLiveReceipt,
  formatMicrousd,
  isTerminalLiveStatus,
  liveReadiness,
  mergeLiveRun,
} from "../lib/swarm/live-ui.mjs";

test("every backend status is terminal except RUNNING", () => {
  assert.equal(LIVE_RUN_STATUSES.length, 21);
  for (const status of LIVE_RUN_STATUSES) {
    assert.equal(isTerminalLiveStatus(status), status !== "RUNNING", status);
  }
  assert.equal(isTerminalLiveStatus("READY"), false);
});

test("micro-USD formatting is exact and rejects invalid values", () => {
  assert.equal(formatMicrousd(0), "$0.000000");
  assert.equal(formatMicrousd(158), "$0.000158");
  assert.equal(formatMicrousd(802), "$0.000802");
  assert.equal(formatMicrousd(10_000_000), "$10.000000");
  assert.equal(formatMicrousd(-1), "$—");
  assert.equal(formatMicrousd(0.5), "$—");
});

test("live readiness requires gate, credential, idle dispatch, and budget headroom", () => {
  const readyHealth = {
    liveEnabled: true,
    providerConfigured: true,
    nextReservationMicrousd: 802,
    budget: {
      authorizedMicrousd: 10_000_000,
      reconciledMicrousd: 158,
      outstandingMicrousd: 0,
      startThresholdMicrousd: 9_000_000,
      dispatchActive: false,
    },
  };
  assert.deepEqual(liveReadiness(readyHealth), {
    ready: true,
    reason: "Live provider is ready.",
  });
  assert.equal(liveReadiness({ ...readyHealth, liveEnabled: false }).reason, "Live execution is disabled.");
  assert.equal(
    liveReadiness({ ...readyHealth, providerConfigured: false }).reason,
    "The provider credential is not configured.",
  );
  assert.equal(
    liveReadiness({ ...readyHealth, budget: { ...readyHealth.budget, dispatchActive: true } }).reason,
    "Another provider call is active.",
  );
  assert.equal(
    liveReadiness({ ...readyHealth, budget: { ...readyHealth.budget, reconciledMicrousd: 9_000_000 } }).reason,
    "The experiment budget threshold has been reached.",
  );
  assert.equal(
    liveReadiness({ ...readyHealth, budget: { ...readyHealth.budget, reconciledMicrousd: 8_999_198 } }).reason,
    "The experiment budget threshold has been reached.",
  );
  assert.equal(
    liveReadiness({
      ...readyHealth,
      budget: {
        ...readyHealth.budget,
        authorizedMicrousd: 0,
        startThresholdMicrousd: 0,
        reconciledMicrousd: 0,
      },
    }).reason,
    "No live experiment budget is authorized.",
  );
  assert.equal(liveReadiness(null).reason, "Provider status is unavailable.");
});

test("run merging rejects stale updates and never regresses a terminal state", () => {
  const running = { id: "run_1", status: "RUNNING", updatedAt: 10, callCount: 0 };
  const stopped = { id: "run_1", status: "USER_STOPPED", updatedAt: 12, callCount: 0 };
  assert.deepEqual(mergeLiveRun(running, stopped), stopped);
  assert.deepEqual(mergeLiveRun(stopped, { ...running, updatedAt: 13 }), stopped);
  assert.deepEqual(
    mergeLiveRun({ ...running, updatedAt: 20 }, { ...running, updatedAt: 19, callCount: 1 }),
    { ...running, updatedAt: 20 },
  );
});

test("live receipt excludes task, record, and provider content", () => {
  const receipt = buildRedactedLiveReceipt({
    id: "run_safe",
    status: "UNKNOWN_OUTCOME",
    currentAgent: "researcher",
    stopRequested: true,
    callCount: 1,
    handoffCount: 0,
    visits: { researcher: 1, architect: 0, coder: 0, reviewer: 0 },
    reservedTokens: 4_000,
    usedTokens: 0,
    outstandingMicrousd: 802,
    reconciledMicrousd: 0,
    maxCalls: 6,
    maxHandoffs: 5,
    maxVisitsPerAgent: 2,
    tokenBudget: 24_000,
    maxInputTokens: 3_000,
    maxOutputTokens: 1_000,
    runSpendCapMicrousd: 4_812,
    lastErrorCode: "USAGE_UNKNOWN",
    createdAt: 1,
    updatedAt: 2,
    deadlineAt: 60_001,
    objective: "TOP SECRET OBJECTIVE",
    acceptanceCriteria: "TOP SECRET CRITERIA",
    records: [{ content: "TOP SECRET MODEL OUTPUT" }],
    activeStep: {
      id: "step_safe",
      stepNumber: 1,
      agent: "researcher",
      status: "UNKNOWN_OUTCOME",
      reservedMicrousd: 802,
      safeErrorCode: "USAGE_UNKNOWN",
      providerRequestId: "req_safe",
      responseBody: "TOP SECRET PROVIDER BODY",
    },
  });
  const serialized = JSON.stringify(receipt);
  for (const forbidden of [
    "TOP SECRET OBJECTIVE",
    "TOP SECRET CRITERIA",
    "TOP SECRET MODEL OUTPUT",
    "TOP SECRET PROVIDER BODY",
    '"objective"',
    '"acceptanceCriteria"',
    '"records"',
    '"content"',
    '"providerRequestId"',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(receipt.cost.outstandingMicrousd, 802);
  assert.equal(receipt.activeStep.safeErrorCode, "USAGE_UNKNOWN");
});
