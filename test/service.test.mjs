import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
    if (specifier === "@/app/chatgpt-auth") {
      return {
        url: "data:text/javascript,export async function getChatGPTUser(){return null;}",
        shortCircuit: true,
      };
    }
    if (
      specifier.startsWith("./") &&
      !specifier.includes(".", 2) &&
      context.parentURL?.includes("/lib/server/")
    ) {
      return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const service = await import("../lib/server/service.ts");

class BoundStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) { return new BoundStatement(this.database, this.sql, values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values), meta: {} };
  }
  async run() { return this.runSync(); }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    const migration = readFileSync(
      new URL("../drizzle/0000_sad_iron_fist.sql", import.meta.url),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "");
    this.database.exec(migration);
  }
  prepare(sql) { return new BoundStatement(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const START = 1_800_000_000_000;
const TEST_BUDGET = Object.freeze({
  authorizedMicrousd: 10_000_000,
  startThresholdMicrousd: 9_000_000,
});

function dependencies(db, invoke, now = START) {
  return {
    db,
    invoke,
    now: () => now,
    liveEnabled: true,
    model: "gpt-6-luna",
    apiKey: "test-key-not-real",
    experimentBudget: TEST_BUDGET,
  };
}

function successResult(record = "A bounded shared record.", next = "architect") {
  return {
    ok: true,
    result: { next, record, findings: [], evidence: [], uncertainty: [] },
    usage: {
      inputTokens: 250,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 350,
    },
    providerRequestId: "req_safe",
    providerResponseId: "resp_safe",
    processingMs: 4,
  };
}

async function makeRun(db, invoke) {
  return service.createLiveRun(
    "user_1",
    {
      idempotencyKey: "create_test_1",
      objective: "Produce a bounded work plan",
      acceptanceCriteria: "Every claim has a recorded basis",
    },
    dependencies(db, invoke),
  );
}

test("one step dispatches once, commits usage, and duplicate input never calls again", async () => {
  const db = new TestD1();
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return successResult();
  };
  const created = await makeRun(db, invoke);
  const first = await service.stepLiveRun(
    "user_1",
    created.run.id,
    { idempotencyKey: "step_test_1" },
    dependencies(db, invoke, START + 1),
  );
  const duplicate = await service.stepLiveRun(
    "user_1",
    created.run.id,
    { idempotencyKey: "step_test_1" },
    dependencies(db, invoke, START + 2),
  );
  assert.equal(calls, 1);
  assert.equal(first.step.status, "COMMITTED");
  assert.equal(first.run.currentAgent, "architect");
  assert.equal(first.run.records.length, 1);
  assert.equal(first.run.outstandingMicrousd, 0);
  assert.equal(first.run.reconciledMicrousd, 75);
  assert.equal(duplicate.replayed, true);
});

test("usage uncertainty retains the full reservation and blocks the run", async () => {
  const db = new TestD1();
  const invoke = async () => ({
    ok: false,
    code: "USAGE_UNKNOWN",
    providerRequestId: "req_unknown",
    retryAfterSeconds: null,
    outcomeUnknown: false,
  });
  const created = await makeRun(db, invoke);
  const result = await service.stepLiveRun(
    "user_1",
    created.run.id,
    { idempotencyKey: "step_unknown_1" },
    dependencies(db, invoke, START + 1),
  );
  assert.equal(result.step.status, "UNKNOWN_OUTCOME");
  assert.equal(result.run.status, "UNKNOWN_OUTCOME");
  assert.equal(result.run.outstandingMicrousd, 802);
  assert.equal(result.run.reconciledMicrousd, 0);
});

test("a known authentication rejection releases its reservation without retry", async () => {
  const db = new TestD1();
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return {
      ok: false,
      code: "AUTHENTICATION_FAILED",
      providerRequestId: "req_auth",
      retryAfterSeconds: null,
      outcomeUnknown: false,
    };
  };
  const created = await makeRun(db, invoke);
  const result = await service.stepLiveRun(
    "user_1",
    created.run.id,
    { idempotencyKey: "step_auth_1" },
    dependencies(db, invoke, START + 1),
  );
  assert.equal(calls, 1);
  assert.equal(result.run.status, "AUTH_ERROR");
  assert.equal(result.run.outstandingMicrousd, 0);
  assert.equal(result.run.reconciledMicrousd, 0);
});

test("oversized accumulated memory stops before another provider call", async () => {
  const db = new TestD1();
  let calls = 0;
  const invoke = async () => {
    calls += 1;
    return successResult("x".repeat(2_000));
  };
  const created = await service.createLiveRun(
    "user_1",
    {
      idempotencyKey: "create_large_1",
      objective: "o".repeat(700),
      acceptanceCriteria: "c".repeat(700),
    },
    dependencies(db, invoke),
  );
  await service.stepLiveRun(
    "user_1",
    created.run.id,
    { idempotencyKey: "step_large_1" },
    dependencies(db, invoke, START + 1),
  );
  const stopped = await service.stepLiveRun(
    "user_1",
    created.run.id,
    { idempotencyKey: "step_large_2" },
    dependencies(db, invoke, START + 2),
  );
  assert.equal(calls, 1);
  assert.equal(stopped.run.status, "INPUT_LIMIT");
  assert.equal(stopped.run.callCount, 1);
});

test("live mode is fail-closed before database or provider work", async () => {
  await assert.rejects(
    service.createLiveRun(
      "user_1",
      {
        idempotencyKey: "create_disabled",
        objective: "test",
        acceptanceCriteria: "test",
      },
      { liveEnabled: false },
    ),
    (error) => error.code === "LIVE_DISABLED" && error.status === 503,
  );
});

test("live mode reports a missing provider credential before database work", async () => {
  await assert.rejects(
    service.createLiveRun(
      "user_1",
      {
        idempotencyKey: "create_no_provider",
        objective: "test",
        acceptanceCriteria: "test",
      },
      { liveEnabled: true, model: "gpt-6-luna", apiKey: "" },
    ),
    (error) => error.code === "PROVIDER_NOT_CONFIGURED" && error.status === 503,
  );
});

test("a public clone with zero authorized budget cannot create provider work", async () => {
  const db = new TestD1();
  let calls = 0;
  await assert.rejects(
    service.createLiveRun(
      "user_1",
      {
        idempotencyKey: "create_zero_budget",
        objective: "test",
        acceptanceCriteria: "test",
      },
      {
        ...dependencies(db, async () => {
          calls += 1;
          return successResult();
        }),
        experimentBudget: { authorizedMicrousd: 0, startThresholdMicrousd: 0 },
      },
    ),
    /run spend cap exceeds the internal project threshold/,
  );
  assert.equal(calls, 0);
  assert.equal(db.database.prepare("SELECT COUNT(*) AS count FROM runs").get().count, 0);
});

test("experiment status exposes only provider readiness, never credential material", async () => {
  const db = new TestD1();
  const ready = await service.experimentStatus({
    db,
    now: () => START,
    liveEnabled: false,
    model: "gpt-6-luna",
    apiKey: "test-key-not-real",
    experimentBudget: TEST_BUDGET,
  });
  const missing = await service.experimentStatus({
    db,
    now: () => START,
    liveEnabled: false,
    model: "gpt-6-luna",
    apiKey: "",
    experimentBudget: TEST_BUDGET,
  });

  assert.equal(ready.providerConfigured, true);
  assert.equal(ready.nextReservationMicrousd, 802);
  assert.equal(missing.providerConfigured, false);
  assert.equal(Object.hasOwn(ready, "apiKey"), false);
  assert.equal(JSON.stringify(ready).includes("test-key-not-real"), false);
});
