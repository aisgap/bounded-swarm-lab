import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {};", shortCircuit: true };
    }
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env = {};", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const runtime = await import("../lib/server/runtime.ts");

test("public budget configuration defaults to zero authorization", () => {
  assert.deepEqual(runtime.parseExperimentBudgetConfig({}), {
    authorizedMicrousd: 0,
    startThresholdMicrousd: 0,
  });
});

test("an explicit bounded pilot configuration is accepted", () => {
  assert.deepEqual(runtime.parseExperimentBudgetConfig({
    SWARM_AUTHORIZED_MICROUSD: "10000000",
    SWARM_START_THRESHOLD_MICROUSD: "9000000",
  }), {
    authorizedMicrousd: 10_000_000,
    startThresholdMicrousd: 9_000_000,
  });
});

test("partial, malformed, or over-ceiling budget configuration fails closed", () => {
  for (const source of [
    { SWARM_AUTHORIZED_MICROUSD: "10000000" },
    { SWARM_START_THRESHOLD_MICROUSD: "9000000" },
    { SWARM_AUTHORIZED_MICROUSD: "10.00", SWARM_START_THRESHOLD_MICROUSD: "9" },
    { SWARM_AUTHORIZED_MICROUSD: "10000001", SWARM_START_THRESHOLD_MICROUSD: "9000000" },
    { SWARM_AUTHORIZED_MICROUSD: "9000000", SWARM_START_THRESHOLD_MICROUSD: "10000000" },
    { SWARM_AUTHORIZED_MICROUSD: "10000000", SWARM_START_THRESHOLD_MICROUSD: "0" },
  ]) {
    assert.throws(
      () => runtime.parseExperimentBudgetConfig(source),
      /EXPERIMENT_BUDGET_CONFIGURATION_INVALID/,
    );
  }
});
