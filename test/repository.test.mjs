import assert from "node:assert/strict";
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
    if (specifier === "./runtime" && context.parentURL?.endsWith("/lib/server/repository.ts")) {
      return nextResolve("./runtime.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const repository = await import("../lib/server/repository.ts");

class BoundStatement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new BoundStatement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values), meta: {} };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(schemaSql);
  }

  prepare(sql) {
    return new BoundStatement(this.database, sql);
  }

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

const schemaSql = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  model TEXT NOT NULL,
  price_version TEXT NOT NULL,
  status TEXT NOT NULL,
  current_agent TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  handoff_count INTEGER NOT NULL DEFAULT 0,
  researcher_visits INTEGER NOT NULL DEFAULT 0,
  architect_visits INTEGER NOT NULL DEFAULT 0,
  coder_visits INTEGER NOT NULL DEFAULT 0,
  reviewer_visits INTEGER NOT NULL DEFAULT 0,
  max_calls INTEGER NOT NULL,
  max_handoffs INTEGER NOT NULL,
  max_visits_per_agent INTEGER NOT NULL,
  token_budget INTEGER NOT NULL,
  max_input_tokens INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  run_spend_cap_microusd INTEGER NOT NULL,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  outstanding_microusd INTEGER NOT NULL DEFAULT 0,
  reconciled_microusd INTEGER NOT NULL DEFAULT 0,
  active_step_id TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  deadline_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key)
);
CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  step_number INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  next_agent TEXT,
  client_request_id TEXT NOT NULL,
  provider_request_id TEXT,
  provider_response_id TEXT,
  reserved_input_tokens INTEGER NOT NULL,
  reserved_output_tokens INTEGER NOT NULL,
  reserved_microusd INTEGER NOT NULL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_tokens INTEGER,
  actual_microusd INTEGER,
  safe_error_code TEXT,
  retry_after_seconds INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(run_id, step_number),
  UNIQUE(run_id, idempotency_key)
);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  author TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE TABLE experiment_budget (
  id TEXT PRIMARY KEY,
  authorized_microusd INTEGER NOT NULL,
  start_threshold_microusd INTEGER NOT NULL,
  outstanding_microusd INTEGER NOT NULL DEFAULT 0,
  reconciled_microusd INTEGER NOT NULL DEFAULT 0,
  active_step_id TEXT,
  lease_expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  event_type TEXT NOT NULL,
  safe_metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO experiment_budget (
  id, authorized_microusd, start_threshold_microusd,
  outstanding_microusd, reconciled_microusd, version, updated_at
) VALUES ('initial-openai-experiments-v1', 0, 0, 0, 0, 0, 0);
`;

const NOW = 1_800_000_000_000;
const TEST_BUDGET = Object.freeze({
  authorizedMicrousd: 10_000_000,
  startThresholdMicrousd: 9_000_000,
});

function runInput(overrides = {}) {
  return {
    id: overrides.id ?? "run_1",
    userId: overrides.userId ?? "user_1",
    idempotencyKey: overrides.idempotencyKey ?? "create_1",
    mode: "LIVE_BOUNDED",
    objective: overrides.objective ?? "confidential objective",
    acceptanceCriteria: "bounded completion",
    model: "gpt-6-luna",
    priceVersion: "test-v1",
    maxCalls: 6,
    maxHandoffs: 5,
    maxVisitsPerAgent: 2,
    tokenBudget: 24_000,
    maxInputTokens: 3_000,
    maxOutputTokens: 1_000,
    runSpendCapMicrousd: 100_000,
    experimentBudget: TEST_BUDGET,
    now: NOW,
    deadlineAt: NOW + 60_000,
    ...overrides,
  };
}

test("an untouched zero ledger initializes once and later configuration changes fail closed", async () => {
  const db = new TestD1();
  const before = await repository.ensureExperimentBudget(db, NOW);
  assert.equal(before.authorizedMicrousd, 0);
  assert.equal(before.startThresholdMicrousd, 0);

  const initialized = await repository.ensureExperimentBudget(db, NOW + 1, TEST_BUDGET);
  assert.equal(initialized.authorizedMicrousd, 10_000_000);
  assert.equal(initialized.startThresholdMicrousd, 9_000_000);
  assert.equal(initialized.version, 1);

  await assert.rejects(
    repository.ensureExperimentBudget(db, NOW + 2, {
      authorizedMicrousd: 5_000_000,
      startThresholdMicrousd: 4_000_000,
    }),
    /EXPERIMENT_BUDGET_CONFIGURATION_MISMATCH/,
  );

  const touched = new TestD1();
  await touched.prepare(
    "UPDATE experiment_budget SET reconciled_microusd = 1 WHERE id = ?",
  ).bind("initial-openai-experiments-v1").run();
  await assert.rejects(
    repository.ensureExperimentBudget(touched, NOW + 1, TEST_BUDGET),
    /EXPERIMENT_BUDGET_CONFIGURATION_MISMATCH/,
  );
});

function reservation(overrides = {}) {
  return {
    id: overrides.id ?? "step_1",
    runId: overrides.runId ?? "run_1",
    userId: overrides.userId ?? "user_1",
    idempotencyKey: overrides.idempotencyKey ?? "dispatch_1",
    expectedAgent: "researcher",
    clientRequestId: overrides.clientRequestId ?? "client_1",
    reservedInputTokens: 3_000,
    reservedOutputTokens: 1_000,
    reservedMicrousd: overrides.reservedMicrousd ?? 800,
    now: NOW + 1,
    leaseExpiresAt: NOW + 31_000,
    ...overrides,
  };
}

test("run creation is idempotent and rejects key reuse with different content", async () => {
  const db = new TestD1();
  const first = await repository.createRun(db, runInput());
  const duplicate = await repository.createRun(db, runInput({ id: "run_other" }));
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.id, "run_1");
  await assert.rejects(
    repository.createRun(db, runInput({ id: "run_other", objective: "different" })),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("reservation is atomic, user-scoped, and duplicate-safe", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  const first = await repository.reserveStep(db, reservation());
  const duplicate = await repository.reserveStep(db, reservation({ id: "step_other" }));
  assert.equal(first.kind, "reserved");
  assert.equal(duplicate.kind, "existing");
  assert.equal(duplicate.step.id, "step_1");
  assert.equal((await repository.getRunForUser(db, "user_1", "run_1")).callCount, 1);
  assert.equal(await repository.getRunForUser(db, "user_2", "run_1"), null);
  assert.equal(await repository.getStepForUser(db, "user_2", "step_1"), null);
});

test("global concurrency is one and a known rejection releases money", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  await repository.createRun(db, runInput({ id: "run_2", idempotencyKey: "create_2" }));
  const first = await repository.reserveStep(db, reservation());
  const blocked = await repository.reserveStep(db, reservation({
    id: "step_2",
    runId: "run_2",
    idempotencyKey: "dispatch_2",
    clientRequestId: "client_2",
  }));
  assert.equal(first.kind, "reserved");
  assert.deepEqual(blocked, { kind: "denied", reason: "BUSY" });

  await repository.rejectStepKnown(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    runStatus: "PROVIDER_ERROR",
    safeErrorCode: "PROVIDER_SERVER_ERROR",
    now: NOW + 2,
  });
  const budget = await repository.ensureExperimentBudget(db, NOW + 3);
  assert.equal(budget.outstandingMicrousd, 0);
  assert.equal(budget.reconciledMicrousd, 0);

  const second = await repository.reserveStep(db, reservation({
    id: "step_2",
    runId: "run_2",
    idempotencyKey: "dispatch_2",
    clientRequestId: "client_2",
    now: NOW + 3,
  }));
  assert.equal(second.kind, "reserved");
});

test("successful commit reconciles actual cost and writes one record", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  await repository.reserveStep(db, reservation());
  const dispatch = await repository.markStepDispatching(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 2,
  });
  assert.equal(dispatch.status, "DISPATCHING");
  assert.equal(await repository.markStepDispatching(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 2,
  }), null);

  const committed = await repository.commitStepSuccess(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    providerRequestId: "req_safe",
    providerResponseId: "resp_safe",
    nextAgent: "architect",
    runStatus: "RUNNING",
    incrementHandoff: true,
    usage: {
      inputTokens: 800,
      cachedInputTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 40,
      totalTokens: 900,
    },
    actualMicrousd: 600,
    recordContentJson: JSON.stringify({ record: "private result" }),
    recordId: "record_1",
    now: NOW + 3,
  });
  assert.equal(committed.status, "COMMITTED");
  const run = await repository.getRunForUser(db, "user_1", "run_1");
  assert.equal(run.status, "RUNNING");
  assert.equal(run.currentAgent, "architect");
  assert.equal(run.outstandingMicrousd, 0);
  assert.equal(run.reconciledMicrousd, 600);
  assert.equal(run.usedTokens, 900);
  assert.equal(run.handoffCount, 1);
  const budget = await repository.ensureExperimentBudget(db, NOW + 4);
  assert.equal(budget.outstandingMicrousd, 0);
  assert.equal(budget.reconciledMicrousd, 600);
  assert.equal((await repository.listRecordsForUser(db, "user_1", "run_1")).length, 1);
});

test("a stop racing with commit remains terminal and suppresses the handoff", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  await repository.reserveStep(db, reservation());
  await repository.markStepDispatching(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 2,
  });
  const stopping = await repository.requestRunStop(db, {
    userId: "user_1",
    runId: "run_1",
    now: NOW + 3,
  });
  assert.equal(stopping.stopRequested, true);
  assert.equal(stopping.status, "RUNNING");

  await repository.commitStepSuccess(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    providerRequestId: "req_safe",
    providerResponseId: "resp_safe",
    nextAgent: "architect",
    runStatus: "RUNNING",
    incrementHandoff: true,
    usage: {
      inputTokens: 250,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 350,
    },
    actualMicrousd: 75,
    recordContentJson: JSON.stringify({ record: "committed before stop settled" }),
    now: NOW + 4,
  });
  const stopped = await repository.getRunForUser(db, "user_1", "run_1");
  assert.equal(stopped.status, "USER_STOPPED");
  assert.equal(stopped.currentAgent, "researcher");
  assert.equal(stopped.handoffCount, 0);
});

test("unknown outcome retains reservation until conservative operator resolution", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  await repository.reserveStep(db, reservation());
  await repository.markStepDispatching(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 2,
  });
  await repository.markStepUnknown(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 3,
  });
  let budget = await repository.ensureExperimentBudget(db, NOW + 4);
  assert.equal(budget.outstandingMicrousd, 800);
  assert.equal(budget.activeStepId, "step_1");
  assert.equal((await repository.getRunForUser(db, "user_1", "run_1")).status, "UNKNOWN_OUTCOME");

  const resolved = await repository.resolveUnknownAtFullReservation(db, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 5,
  });
  assert.equal(resolved.actualMicrousd, 800);
  budget = await repository.ensureExperimentBudget(db, NOW + 6);
  assert.equal(budget.outstandingMicrousd, 0);
  assert.equal(budget.reconciledMicrousd, 800);
  assert.equal(budget.activeStepId, null);
});

test("expired reserved work is released while expired dispatch stays conservative", async () => {
  const reservedDb = new TestD1();
  await repository.createRun(reservedDb, runInput());
  await repository.reserveStep(reservedDb, reservation());
  assert.equal(
    await repository.recoverExpiredActiveStep(reservedDb, NOW + 31_000),
    "released_reserved",
  );
  let budget = await repository.ensureExperimentBudget(reservedDb, NOW + 31_001);
  assert.equal(budget.activeStepId, null);
  assert.equal(budget.outstandingMicrousd, 0);
  assert.equal((await repository.getRunForUser(reservedDb, "user_1", "run_1")).status, "INTERNAL_ERROR");

  const dispatchedDb = new TestD1();
  await repository.createRun(dispatchedDb, runInput());
  await repository.reserveStep(dispatchedDb, reservation());
  await repository.markStepDispatching(dispatchedDb, {
    userId: "user_1",
    runId: "run_1",
    stepId: "step_1",
    now: NOW + 2,
  });
  assert.equal(
    await repository.recoverExpiredActiveStep(dispatchedDb, NOW + 31_000),
    "retained_unknown",
  );
  budget = await repository.ensureExperimentBudget(dispatchedDb, NOW + 31_001);
  assert.equal(budget.activeStepId, "step_1");
  assert.equal(budget.outstandingMicrousd, 800);
  assert.equal((await repository.getRunForUser(dispatchedDb, "user_1", "run_1")).status, "UNKNOWN_OUTCOME");
});

test("the nine-dollar threshold is checked before any dispatch", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput({ runSpendCapMicrousd: 9_000_000 }));
  await db.prepare(
    "UPDATE experiment_budget SET reconciled_microusd = 8999500 WHERE id = ?",
  ).bind("initial-openai-experiments-v1").run();
  const blocked = await repository.reserveStep(db, reservation({ reservedMicrousd: 500 }));
  assert.deepEqual(blocked, { kind: "denied", reason: "PROJECT_SPEND_LIMIT" });
  assert.equal((await repository.getRunForUser(db, "user_1", "run_1")).callCount, 0);
});

test("stop is monotonic and safe summary excludes confidential fields", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  const stopped = await repository.requestRunStop(db, {
    userId: "user_1",
    runId: "run_1",
    now: NOW + 1,
  });
  assert.equal(stopped.status, "USER_STOPPED");
  const after = await repository.requestRunStop(db, {
    userId: "user_1",
    runId: "run_1",
    now: NOW + 2,
  });
  assert.equal(after.status, "USER_STOPPED");
  const serialized = JSON.stringify(repository.toSafeRunSummary(after));
  assert.equal(serialized.includes("confidential objective"), false);
  assert.equal(serialized.includes("bounded completion"), false);
  const reserve = await repository.reserveStep(db, reservation());
  assert.deepEqual(reserve, { kind: "denied", reason: "RUN_TERMINAL" });
});

test("a pre-dispatch validation failure terminates without reserving money", async () => {
  const db = new TestD1();
  await repository.createRun(db, runInput());
  const stopped = await repository.terminateRunBeforeDispatch(db, {
    userId: "user_1",
    runId: "run_1",
    runStatus: "INPUT_LIMIT",
    safeErrorCode: "INPUT_LIMIT",
    now: NOW + 1,
  });
  assert.equal(stopped.status, "INPUT_LIMIT");
  assert.equal(stopped.callCount, 0);
  assert.equal(stopped.outstandingMicrousd, 0);
  const again = await repository.terminateRunBeforeDispatch(db, {
    userId: "user_1",
    runId: "run_1",
    runStatus: "INTERNAL_ERROR",
    safeErrorCode: "INTERNAL_ERROR",
    now: NOW + 2,
  });
  assert.equal(again.status, "INPUT_LIMIT");
});
