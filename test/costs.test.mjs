import assert from "node:assert/strict";
import test from "node:test";

import {
  PRICE_TABLE_VERSION,
  calculateUsageMicrousd,
  calculateWorstCaseMicrousd,
  canReserveMicrousd,
} from "../lib/swarm/index.mjs";

test("six-call worst-case estimates match the published standard prices", () => {
  const cases = [
    ["gpt-6-luna", 4_800],
    ["gpt-6.1-terra", 48_000],
    ["gpt-6.1-sol", 96_000],
    ["gpt-6-astra", 480_000],
  ];
  for (const [model, expected] of cases) {
    assert.equal(calculateWorstCaseMicrousd(model, 3_000, 1_000) * 6, expected);
  }
});

test("cached input receives the cached rate", () => {
  const cost = calculateUsageMicrousd("gpt-6.1-sol", {
    inputTokens: 3_000,
    cachedInputTokens: 1_000,
    outputTokens: 1_000,
  });
  assert.equal(cost.inputMicrousd, 4_000);
  assert.equal(cost.cachedInputMicrousd, 100);
  assert.equal(cost.outputMicrousd, 10_000);
  assert.equal(cost.totalMicrousd, 14_100);
  assert.equal(cost.priceTableVersion, PRICE_TABLE_VERSION);
});

test("fractional micro-dollar charges round upward conservatively", () => {
  assert.equal(calculateWorstCaseMicrousd("gpt-6-luna", 1, 1), 2);
});

test("reasoning tokens are not double-counted outside outputTokens", () => {
  const a = calculateUsageMicrousd("gpt-6.1-sol", {
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 500,
    reasoningTokens: 400,
  });
  const b = calculateUsageMicrousd("gpt-6.1-sol", {
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 500,
  });
  assert.deepEqual(a, b);
});

test("reservation gate includes reconciled and outstanding amounts", () => {
  assert.equal(canReserveMicrousd({
    reconciledMicrousd: 8_900_000,
    outstandingMicrousd: 80_000,
    requestedMicrousd: 19_999,
    startThresholdMicrousd: 9_000_000,
  }), true);
  assert.equal(canReserveMicrousd({
    reconciledMicrousd: 8_900_000,
    outstandingMicrousd: 80_000,
    requestedMicrousd: 20_000,
    startThresholdMicrousd: 9_000_000,
  }), false);
  assert.equal(canReserveMicrousd({
    reconciledMicrousd: 9_000_000,
    outstandingMicrousd: 0,
    requestedMicrousd: 0,
    startThresholdMicrousd: 9_000_000,
  }), false);
});

test("usage validation rejects unknown models and inconsistent counts", () => {
  assert.throws(() => calculateWorstCaseMicrousd("unknown", 1, 1), /allowlist/i);
  assert.throws(() => calculateUsageMicrousd("gpt-6-luna", {
    inputTokens: 1,
    cachedInputTokens: 2,
    outputTokens: 1,
  }), /cannot exceed/i);
  assert.throws(() => calculateWorstCaseMicrousd("gpt-6-luna", -1, 1), /non-negative/i);
});
