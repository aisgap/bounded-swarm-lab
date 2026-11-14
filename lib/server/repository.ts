import {
  EXPERIMENT_BUDGET_ID,
  MAX_AUTHORIZED_EXPERIMENT_MICROUSD,
  validateExperimentBudgetConfig,
  type ExperimentBudgetConfig,
} from "./runtime";
import { isRunStatus, isTerminalRunStatus } from "../swarm/statuses.mjs";

const RUNNING = "RUNNING";
const UNKNOWN_OUTCOME = "UNKNOWN_OUTCOME";
const RESERVED = "RESERVED";
const DISPATCHING = "DISPATCHING";
const COMMITTED = "COMMITTED";
const REJECTED = "REJECTED";

type RunRow = {
  id: string;
  user_id: string;
  idempotency_key: string;
  mode: string;
  objective: string;
  acceptance_criteria: string;
  model: string;
  price_version: string;
  status: string;
  current_agent: string;
  call_count: number;
  handoff_count: number;
  researcher_visits: number;
  architect_visits: number;
  coder_visits: number;
  reviewer_visits: number;
  max_calls: number;
  max_handoffs: number;
  max_visits_per_agent: number;
  token_budget: number;
  max_input_tokens: number;
  max_output_tokens: number;
  run_spend_cap_microusd: number;
  reserved_tokens: number;
  used_tokens: number;
  outstanding_microusd: number;
  reconciled_microusd: number;
  active_step_id: string | null;
  stop_requested: number;
  version: number;
  deadline_at: number;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
};

type StepRow = {
  id: string;
  run_id: string;
  user_id: string;
  step_number: number;
  idempotency_key: string;
  agent: string;
  status: string;
  next_agent: string | null;
  client_request_id: string;
  provider_request_id: string | null;
  provider_response_id: string | null;
  reserved_input_tokens: number;
  reserved_output_tokens: number;
  reserved_microusd: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  actual_microusd: number | null;
  safe_error_code: string | null;
  retry_after_seconds: number | null;
  started_at: number;
  completed_at: number | null;
};

type BudgetRow = {
  id: string;
  authorized_microusd: number;
  start_threshold_microusd: number;
  outstanding_microusd: number;
  reconciled_microusd: number;
  active_step_id: string | null;
  lease_expires_at: number | null;
  version: number;
  updated_at: number;
};

export type RunRecord = ReturnType<typeof mapRun>;
export type StepRecord = ReturnType<typeof mapStep>;
export type ExperimentBudgetRecord = ReturnType<typeof mapBudget>;

export type CreateRunInput = {
  id?: string;
  userId: string;
  idempotencyKey: string;
  mode: string;
  objective: string;
  acceptanceCriteria: string;
  model: string;
  priceVersion: string;
  maxCalls: number;
  maxHandoffs: number;
  maxVisitsPerAgent: number;
  tokenBudget: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  runSpendCapMicrousd: number;
  experimentBudget: ExperimentBudgetConfig;
  now: number;
  deadlineAt: number;
};

export type ReserveStepInput = {
  id?: string;
  runId: string;
  userId: string;
  idempotencyKey: string;
  expectedAgent: string;
  clientRequestId: string;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedMicrousd: number;
  now: number;
  leaseExpiresAt: number;
};

export type ReservationResult =
  | { kind: "reserved"; step: StepRecord }
  | { kind: "existing"; step: StepRecord }
  | {
      kind: "denied";
      reason:
        | "RUN_NOT_FOUND"
        | "RUN_TERMINAL"
        | "STOP_REQUESTED"
        | "RUN_TIMEOUT"
        | "CALL_LIMIT"
        | "VISIT_LIMIT"
        | "TOKEN_LIMIT"
        | "RUN_COST_LIMIT"
        | "PROJECT_SPEND_LIMIT"
        | "BUSY"
        | "CONCURRENT_REQUEST";
    };

export type UsageForCommit = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export async function ensureExperimentBudget(
  db: D1Database,
  now = Date.now(),
  expectedConfig?: ExperimentBudgetConfig,
): Promise<ExperimentBudgetRecord> {
  requireNonNegativeSafeInteger(now, "now");
  let row = await selectExperimentBudget(db);
  if (!row) throw new Error("EXPERIMENT_BUDGET_UNAVAILABLE");
  validateStoredBudgetConfiguration(row);
  if (!expectedConfig) return mapBudget(row);

  validateExperimentBudgetConfig(expectedConfig);
  if (budgetMatches(row, expectedConfig)) return mapBudget(row);

  if (isUntouchedZeroBudget(row) && expectedConfig.authorizedMicrousd > 0) {
    await db
      .prepare(
        `UPDATE experiment_budget
         SET authorized_microusd = ?, start_threshold_microusd = ?,
             version = version + 1, updated_at = ?
         WHERE id = ?
           AND authorized_microusd = 0
           AND start_threshold_microusd = 0
           AND outstanding_microusd = 0
           AND reconciled_microusd = 0
           AND active_step_id IS NULL
           AND lease_expires_at IS NULL
           AND version = 0
           AND updated_at = 0`,
      )
      .bind(
        expectedConfig.authorizedMicrousd,
        expectedConfig.startThresholdMicrousd,
        now,
        EXPERIMENT_BUDGET_ID,
      )
      .run();
    row = await selectExperimentBudget(db);
    if (!row) throw new Error("EXPERIMENT_BUDGET_UNAVAILABLE");
    validateStoredBudgetConfiguration(row);
    if (budgetMatches(row, expectedConfig)) return mapBudget(row);
  }

  throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_MISMATCH");
}

async function selectExperimentBudget(db: D1Database): Promise<BudgetRow | null> {
  return db
    .prepare("SELECT * FROM experiment_budget WHERE id = ?")
    .bind(EXPERIMENT_BUDGET_ID)
    .first<BudgetRow>();
}

function validateStoredBudgetConfiguration(row: BudgetRow): void {
  try {
    validateExperimentBudgetConfig({
      authorizedMicrousd: row.authorized_microusd,
      startThresholdMicrousd: row.start_threshold_microusd,
    });
  } catch {
    throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_MISMATCH");
  }
  if (row.authorized_microusd > MAX_AUTHORIZED_EXPERIMENT_MICROUSD) {
    throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_MISMATCH");
  }
}

function budgetMatches(row: BudgetRow, config: ExperimentBudgetConfig): boolean {
  return row.authorized_microusd === config.authorizedMicrousd &&
    row.start_threshold_microusd === config.startThresholdMicrousd;
}

function isUntouchedZeroBudget(row: BudgetRow): boolean {
  return row.authorized_microusd === 0 &&
    row.start_threshold_microusd === 0 &&
    row.outstanding_microusd === 0 &&
    row.reconciled_microusd === 0 &&
    row.active_step_id === null &&
    row.lease_expires_at === null &&
    row.version === 0 &&
    row.updated_at === 0;
}

export async function createRun(
  db: D1Database,
  input: CreateRunInput,
): Promise<{ created: boolean; run: RunRecord }> {
  validateCreateRun(input);
  await ensureExperimentBudget(db, input.now, input.experimentBudget);
  const id = input.id ?? `run_${crypto.randomUUID()}`;

  const result = await db
    .prepare(
      `INSERT INTO runs (
        id, user_id, idempotency_key, mode, objective, acceptance_criteria,
        model, price_version, status, current_agent,
        max_calls, max_handoffs, max_visits_per_agent, token_budget,
        max_input_tokens, max_output_tokens, run_spend_cap_microusd,
        deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', 'researcher', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, idempotency_key) DO NOTHING`,
    )
    .bind(
      id,
      input.userId,
      input.idempotencyKey,
      input.mode,
      input.objective,
      input.acceptanceCriteria,
      input.model,
      input.priceVersion,
      input.maxCalls,
      input.maxHandoffs,
      input.maxVisitsPerAgent,
      input.tokenBudget,
      input.maxInputTokens,
      input.maxOutputTokens,
      input.runSpendCapMicrousd,
      input.deadlineAt,
      input.now,
      input.now,
    )
    .run();

  const created = changes(result) === 1;
  const row = await db
    .prepare("SELECT * FROM runs WHERE user_id = ? AND idempotency_key = ?")
    .bind(input.userId, input.idempotencyKey)
    .first<RunRow>();
  if (!row) throw new Error("RUN_CREATE_FAILED");
  if (!created && !sameCreateRequest(row, input)) throw new Error("IDEMPOTENCY_CONFLICT");
  return { created, run: mapRun(row) };
}

export async function getRunForUser(
  db: D1Database,
  userId: string,
  runId: string,
): Promise<RunRecord | null> {
  const row = await db
    .prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?")
    .bind(runId, userId)
    .first<RunRow>();
  return row ? mapRun(row) : null;
}

export async function getRunByIdempotencyKey(
  db: D1Database,
  userId: string,
  idempotencyKey: string,
): Promise<RunRecord | null> {
  const row = await db
    .prepare("SELECT * FROM runs WHERE user_id = ? AND idempotency_key = ?")
    .bind(userId, idempotencyKey)
    .first<RunRow>();
  return row ? mapRun(row) : null;
}

export async function getStepForUser(
  db: D1Database,
  userId: string,
  stepId: string,
): Promise<StepRecord | null> {
  const row = await db
    .prepare("SELECT * FROM steps WHERE id = ? AND user_id = ?")
    .bind(stepId, userId)
    .first<StepRow>();
  return row ? mapStep(row) : null;
}

export async function getStepByIdempotencyKey(
  db: D1Database,
  userId: string,
  runId: string,
  idempotencyKey: string,
): Promise<StepRecord | null> {
  const row = await db
    .prepare(
      "SELECT * FROM steps WHERE run_id = ? AND user_id = ? AND idempotency_key = ?",
    )
    .bind(runId, userId, idempotencyKey)
    .first<StepRow>();
  return row ? mapStep(row) : null;
}

export async function recoverExpiredActiveStep(
  db: D1Database,
  now = Date.now(),
): Promise<"none" | "released_reserved" | "retained_unknown"> {
  const budget = await ensureExperimentBudget(db, now);
  if (!budget.activeStepId || budget.leaseExpiresAt === null || budget.leaseExpiresAt > now) {
    return "none";
  }
  const row = await db
    .prepare("SELECT * FROM steps WHERE id = ?")
    .bind(budget.activeStepId)
    .first<StepRow>();
  if (!row) throw new Error("ACTIVE_STEP_INVARIANT_FAILED");
  const step = mapStep(row);
  if (step.status === RESERVED) {
    await rejectStepKnown(db, {
      userId: step.userId,
      runId: step.runId,
      stepId: step.id,
      runStatus: "INTERNAL_ERROR",
      safeErrorCode: "STALE_RESERVED_RELEASED",
      now,
    });
    return "released_reserved";
  }
  if (step.status === DISPATCHING) {
    await markStepUnknown(db, {
      userId: step.userId,
      runId: step.runId,
      stepId: step.id,
      safeErrorCode: "STALE_DISPATCH_UNKNOWN",
      now,
    });
    return "retained_unknown";
  }
  return "none";
}

export async function listRecordsForUser(
  db: D1Database,
  userId: string,
  runId: string,
): Promise<Array<{ sequence: number; author: string; contentJson: string; createdAt: number }>> {
  const result = await db
    .prepare(
      `SELECT r.sequence, r.author, r.content_json, r.created_at
       FROM records r
       JOIN runs owner ON owner.id = r.run_id
       WHERE r.run_id = ? AND owner.user_id = ?
       ORDER BY r.sequence ASC`,
    )
    .bind(runId, userId)
    .all<{ sequence: number; author: string; content_json: string; created_at: number }>();
  return result.results.map((row) => ({
    sequence: row.sequence,
    author: row.author,
    contentJson: row.content_json,
    createdAt: row.created_at,
  }));
}

export async function reserveStep(
  db: D1Database,
  input: ReserveStepInput,
): Promise<ReservationResult> {
  validateReserveStep(input);
  await ensureExperimentBudget(db, input.now);

  const existing = await getStepByIdempotencyKey(
    db,
    input.userId,
    input.runId,
    input.idempotencyKey,
  );
  if (existing) return { kind: "existing", step: existing };

  const stepId = input.id ?? `step_${crypto.randomUUID()}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO steps (
          id, run_id, user_id, step_number, idempotency_key, agent, status,
          client_request_id, reserved_input_tokens, reserved_output_tokens,
          reserved_microusd, started_at
        )
        SELECT ?, r.id, r.user_id, r.call_count + 1, ?, r.current_agent, 'RESERVED',
          ?, ?, ?, ?, ?
        FROM runs r
        JOIN experiment_budget b ON b.id = ?
        WHERE r.id = ?
          AND r.user_id = ?
          AND r.status = 'RUNNING'
          AND r.stop_requested = 0
          AND r.active_step_id IS NULL
          AND r.deadline_at > ?
          AND r.current_agent = ?
          AND r.call_count < r.max_calls
          AND (CASE r.current_agent
            WHEN 'researcher' THEN r.researcher_visits
            WHEN 'architect' THEN r.architect_visits
            WHEN 'coder' THEN r.coder_visits
            WHEN 'reviewer' THEN r.reviewer_visits
            ELSE r.max_visits_per_agent
          END) < r.max_visits_per_agent
          AND r.reserved_tokens + ? + ? <= r.token_budget
          AND r.reconciled_microusd + r.outstanding_microusd + ? <= r.run_spend_cap_microusd
          AND b.active_step_id IS NULL
          AND b.reconciled_microusd + b.outstanding_microusd + ? < b.start_threshold_microusd
          AND b.reconciled_microusd + b.outstanding_microusd + ? <= b.authorized_microusd
          AND NOT EXISTS (
            SELECT 1 FROM steps duplicate
            WHERE duplicate.run_id = r.id AND duplicate.idempotency_key = ?
          )`,
      )
      .bind(
        stepId,
        input.idempotencyKey,
        input.clientRequestId,
        input.reservedInputTokens,
        input.reservedOutputTokens,
        input.reservedMicrousd,
        input.now,
        EXPERIMENT_BUDGET_ID,
        input.runId,
        input.userId,
        input.now,
        input.expectedAgent,
        input.reservedInputTokens,
        input.reservedOutputTokens,
        input.reservedMicrousd,
        input.reservedMicrousd,
        input.reservedMicrousd,
        input.idempotencyKey,
      ),
    db
      .prepare(
        `UPDATE experiment_budget
         SET outstanding_microusd = outstanding_microusd + ?,
             active_step_id = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?
           AND active_step_id IS NULL
           AND EXISTS (SELECT 1 FROM steps WHERE id = ? AND status = 'RESERVED')`,
      )
      .bind(
        input.reservedMicrousd,
        stepId,
        input.leaseExpiresAt,
        input.now,
        EXPERIMENT_BUDGET_ID,
        stepId,
      ),
    db
      .prepare(
        `UPDATE runs
         SET active_step_id = ?,
             call_count = call_count + 1,
             reserved_tokens = reserved_tokens + ? + ?,
             outstanding_microusd = outstanding_microusd + ?,
             researcher_visits = researcher_visits + CASE WHEN current_agent = 'researcher' THEN 1 ELSE 0 END,
             architect_visits = architect_visits + CASE WHEN current_agent = 'architect' THEN 1 ELSE 0 END,
             coder_visits = coder_visits + CASE WHEN current_agent = 'coder' THEN 1 ELSE 0 END,
             reviewer_visits = reviewer_visits + CASE WHEN current_agent = 'reviewer' THEN 1 ELSE 0 END,
             version = version + 1,
             updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'RUNNING' AND active_step_id IS NULL
           AND EXISTS (SELECT 1 FROM steps WHERE id = ? AND run_id = runs.id AND status = 'RESERVED')`,
      )
      .bind(
        stepId,
        input.reservedInputTokens,
        input.reservedOutputTokens,
        input.reservedMicrousd,
        input.now,
        input.runId,
        input.userId,
        stepId,
      ),
    auditStatement(db, {
      id: `audit_${crypto.randomUUID()}`,
      userId: input.userId,
      runId: input.runId,
      stepId,
      eventType: "step_reserved",
      safeMetadata: { status: RESERVED },
      now: input.now,
      onlyIfStepExists: true,
    }),
  ];

  const results = await db.batch(statements);
  const inserted = changes(results[0]);
  if (inserted === 1) {
    if (changes(results[1]) !== 1 || changes(results[2]) !== 1) {
      throw new Error("RESERVATION_INVARIANT_FAILED");
    }
    const row = await getStepForUser(db, input.userId, stepId);
    if (!row) throw new Error("RESERVATION_READBACK_FAILED");
    return { kind: "reserved", step: row };
  }

  const raced = await getStepByIdempotencyKey(
    db,
    input.userId,
    input.runId,
    input.idempotencyKey,
  );
  if (raced) return { kind: "existing", step: raced };
  return { kind: "denied", reason: await reservationDenialReason(db, input) };
}

export async function markStepDispatching(
  db: D1Database,
  input: { userId: string; runId: string; stepId: string; now: number },
): Promise<StepRecord | null> {
  const result = await db
    .prepare(
      `UPDATE steps
       SET status = 'DISPATCHING'
       WHERE id = ? AND run_id = ? AND user_id = ? AND status = 'RESERVED'
         AND EXISTS (
           SELECT 1 FROM runs r
           WHERE r.id = steps.run_id AND r.user_id = steps.user_id
             AND r.status = 'RUNNING' AND r.active_step_id = steps.id
         )
         AND EXISTS (
           SELECT 1 FROM experiment_budget b
           WHERE b.id = ? AND b.active_step_id = steps.id
         )`,
    )
    .bind(input.stepId, input.runId, input.userId, EXPERIMENT_BUDGET_ID)
    .run();
  if (changes(result) !== 1) return null;
  return getStepForUser(db, input.userId, input.stepId);
}

export async function commitStepSuccess(
  db: D1Database,
  input: {
    userId: string;
    runId: string;
    stepId: string;
    providerRequestId: string | null;
    providerResponseId: string;
    nextAgent: string;
    runStatus: string;
    incrementHandoff: boolean;
    usage: UsageForCommit;
    actualMicrousd: number;
    recordContentJson: string;
    recordId?: string;
    now: number;
  },
): Promise<StepRecord> {
  validateCommit(input);
  const current = await getStepForUser(db, input.userId, input.stepId);
  if (!current || current.runId !== input.runId) throw new Error("STEP_NOT_FOUND");
  if (current.status === COMMITTED) return current;
  if (current.status !== DISPATCHING) throw new Error("STEP_NOT_DISPATCHING");
  if (input.actualMicrousd > current.reservedMicrousd) throw new Error("COST_EXCEEDS_RESERVATION");
  if (
    input.usage.inputTokens > current.reservedInputTokens ||
    input.usage.outputTokens > current.reservedOutputTokens ||
    input.usage.totalTokens !== input.usage.inputTokens + input.usage.outputTokens
  ) {
    throw new Error("USAGE_EXCEEDS_RESERVATION");
  }

  const recordId = input.recordId ?? `record_${crypto.randomUUID()}`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE steps
         SET status = 'COMMITTED', next_agent = ?, provider_request_id = ?, provider_response_id = ?,
             input_tokens = ?, cached_input_tokens = ?, cache_write_tokens = ?,
             output_tokens = ?, reasoning_tokens = ?, total_tokens = ?, actual_microusd = ?,
             completed_at = ?
         WHERE id = ? AND run_id = ? AND user_id = ? AND status = 'DISPATCHING'`,
      )
      .bind(
        input.nextAgent,
        input.providerRequestId,
        input.providerResponseId,
        input.usage.inputTokens,
        input.usage.cachedInputTokens,
        input.usage.cacheWriteTokens,
        input.usage.outputTokens,
        input.usage.reasoningTokens,
        input.usage.totalTokens,
        input.actualMicrousd,
        input.now,
        input.stepId,
        input.runId,
        input.userId,
      ),
    db
      .prepare(
        `INSERT INTO records (id, run_id, step_id, sequence, author, content_json, created_at)
         SELECT ?, run_id, id, step_number, agent, ?, ?
         FROM steps
         WHERE id = ? AND run_id = ? AND user_id = ? AND status = 'COMMITTED'
         ON CONFLICT(run_id, sequence) DO NOTHING`,
      )
      .bind(
        recordId,
        input.recordContentJson,
        input.now,
        input.stepId,
        input.runId,
        input.userId,
      ),
    db
      .prepare(
        `UPDATE experiment_budget
         SET outstanding_microusd = outstanding_microusd - ?,
             reconciled_microusd = reconciled_microusd + ?,
             active_step_id = NULL, lease_expires_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND active_step_id = ? AND outstanding_microusd >= ?`,
      )
      .bind(
        current.reservedMicrousd,
        input.actualMicrousd,
        input.now,
        EXPERIMENT_BUDGET_ID,
        input.stepId,
        current.reservedMicrousd,
      ),
    db
      .prepare(
        `UPDATE runs
         SET active_step_id = NULL,
             used_tokens = used_tokens + ?,
             outstanding_microusd = outstanding_microusd - ?,
             reconciled_microusd = reconciled_microusd + ?,
             handoff_count = handoff_count + CASE WHEN stop_requested = 0 THEN ? ELSE 0 END,
             current_agent = CASE
               WHEN stop_requested = 0 AND ? = 'RUNNING' THEN ?
               ELSE current_agent
             END,
             status = CASE WHEN stop_requested = 1 THEN 'USER_STOPPED' ELSE ? END,
             last_error_code = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'RUNNING'
           AND active_step_id = ? AND outstanding_microusd >= ?`,
      )
      .bind(
        input.usage.totalTokens,
        current.reservedMicrousd,
        input.actualMicrousd,
        input.incrementHandoff ? 1 : 0,
        input.runStatus,
        input.nextAgent,
        input.runStatus,
        input.now,
        input.runId,
        input.userId,
        input.stepId,
        current.reservedMicrousd,
      ),
    auditStatement(db, {
      id: `audit_${crypto.randomUUID()}`,
      userId: input.userId,
      runId: input.runId,
      stepId: input.stepId,
      eventType: "step_committed",
      safeMetadata: {
        status: COMMITTED,
        actualMicrousd: input.actualMicrousd,
        totalTokens: input.usage.totalTokens,
      },
      now: input.now,
      onlyIfStepExists: true,
    }),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1 || changes(results[3]) !== 1) {
    throw new Error("COMMIT_INVARIANT_FAILED");
  }
  const committed = await getStepForUser(db, input.userId, input.stepId);
  if (!committed) throw new Error("COMMIT_READBACK_FAILED");
  return committed;
}

export async function rejectStepKnown(
  db: D1Database,
  input: {
    userId: string;
    runId: string;
    stepId: string;
    runStatus: string;
    safeErrorCode: string;
    providerRequestId?: string | null;
    retryAfterSeconds?: number | null;
    now: number;
  },
): Promise<StepRecord> {
  requireTerminalStatus(input.runStatus);
  requireSafeIdentifier(input.safeErrorCode, "safeErrorCode");
  const current = await getStepForUser(db, input.userId, input.stepId);
  if (!current || current.runId !== input.runId) throw new Error("STEP_NOT_FOUND");
  if (current.status === REJECTED) return current;
  if (current.status !== DISPATCHING && current.status !== RESERVED) throw new Error("STEP_CANNOT_BE_REJECTED");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE steps
         SET status = 'REJECTED', safe_error_code = ?, provider_request_id = ?,
             retry_after_seconds = ?, completed_at = ?
         WHERE id = ? AND run_id = ? AND user_id = ? AND status IN ('RESERVED', 'DISPATCHING')`,
      )
      .bind(
        input.safeErrorCode,
        input.providerRequestId ?? null,
        input.retryAfterSeconds ?? null,
        input.now,
        input.stepId,
        input.runId,
        input.userId,
      ),
    db
      .prepare(
        `UPDATE experiment_budget
         SET outstanding_microusd = outstanding_microusd - ?,
             active_step_id = NULL, lease_expires_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND active_step_id = ? AND outstanding_microusd >= ?`,
      )
      .bind(
        current.reservedMicrousd,
        input.now,
        EXPERIMENT_BUDGET_ID,
        input.stepId,
        current.reservedMicrousd,
      ),
    db
      .prepare(
        `UPDATE runs
         SET active_step_id = NULL,
             outstanding_microusd = outstanding_microusd - ?,
             status = ?, last_error_code = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'RUNNING'
           AND active_step_id = ? AND outstanding_microusd >= ?`,
      )
      .bind(
        current.reservedMicrousd,
        input.runStatus,
        input.safeErrorCode,
        input.now,
        input.runId,
        input.userId,
        input.stepId,
        current.reservedMicrousd,
      ),
    auditStatement(db, {
      id: `audit_${crypto.randomUUID()}`,
      userId: input.userId,
      runId: input.runId,
      stepId: input.stepId,
      eventType: "step_rejected",
      safeMetadata: { status: REJECTED, errorCode: input.safeErrorCode },
      now: input.now,
      onlyIfStepExists: true,
    }),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1) {
    throw new Error("REJECTION_INVARIANT_FAILED");
  }
  const rejected = await getStepForUser(db, input.userId, input.stepId);
  if (!rejected) throw new Error("REJECTION_READBACK_FAILED");
  return rejected;
}

export async function markStepUnknown(
  db: D1Database,
  input: {
    userId: string;
    runId: string;
    stepId: string;
    safeErrorCode?: string;
    providerRequestId?: string | null;
    now: number;
  },
): Promise<StepRecord> {
  const errorCode = input.safeErrorCode ?? UNKNOWN_OUTCOME;
  requireSafeIdentifier(errorCode, "safeErrorCode");
  const current = await getStepForUser(db, input.userId, input.stepId);
  if (!current || current.runId !== input.runId) throw new Error("STEP_NOT_FOUND");
  if (current.status === UNKNOWN_OUTCOME) return current;
  if (current.status !== DISPATCHING) throw new Error("STEP_NOT_DISPATCHING");
  const results = await db.batch([
    db
      .prepare(
        `UPDATE steps
         SET status = 'UNKNOWN_OUTCOME', safe_error_code = ?, provider_request_id = ?, completed_at = ?
         WHERE id = ? AND run_id = ? AND user_id = ? AND status = 'DISPATCHING'`,
      )
      .bind(
        errorCode,
        input.providerRequestId ?? null,
        input.now,
        input.stepId,
        input.runId,
        input.userId,
      ),
    db
      .prepare(
        `UPDATE runs
         SET status = 'UNKNOWN_OUTCOME', last_error_code = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'RUNNING' AND active_step_id = ?`,
      )
      .bind(errorCode, input.now, input.runId, input.userId, input.stepId),
    auditStatement(db, {
      id: `audit_${crypto.randomUUID()}`,
      userId: input.userId,
      runId: input.runId,
      stepId: input.stepId,
      eventType: "step_unknown_outcome",
      safeMetadata: { status: UNKNOWN_OUTCOME, errorCode },
      now: input.now,
      onlyIfStepExists: true,
    }),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1) {
    throw new Error("UNKNOWN_OUTCOME_INVARIANT_FAILED");
  }
  const unknown = await getStepForUser(db, input.userId, input.stepId);
  if (!unknown) throw new Error("UNKNOWN_OUTCOME_READBACK_FAILED");
  return unknown;
}

export async function requestRunStop(
  db: D1Database,
  input: { userId: string; runId: string; now: number },
): Promise<RunRecord | null> {
  await db
    .prepare(
      `UPDATE runs
       SET stop_requested = 1,
           status = CASE WHEN active_step_id IS NULL THEN 'USER_STOPPED' ELSE status END,
           version = version + 1, updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'RUNNING'`,
    )
    .bind(input.now, input.runId, input.userId)
    .run();
  return getRunForUser(db, input.userId, input.runId);
}

export async function terminateRunBeforeDispatch(
  db: D1Database,
  input: {
    userId: string;
    runId: string;
    runStatus: string;
    safeErrorCode: string;
    now: number;
  },
): Promise<RunRecord | null> {
  requireTerminalStatus(input.runStatus);
  requireSafeIdentifier(input.safeErrorCode, "safeErrorCode");
  const auditId = `audit_${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        `UPDATE runs
         SET status = ?, last_error_code = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'RUNNING' AND active_step_id IS NULL`,
      )
      .bind(
        input.runStatus,
        input.safeErrorCode,
        input.now,
        input.runId,
        input.userId,
      ),
    db
      .prepare(
        `INSERT INTO audit_events (
          id, user_id, run_id, step_id, event_type, safe_metadata_json, created_at
        )
        SELECT ?, ?, ?, NULL, 'run_stopped_before_dispatch', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM runs
          WHERE id = ? AND user_id = ? AND status = ? AND last_error_code = ?
        )`,
      )
      .bind(
        auditId,
        input.userId,
        input.runId,
        JSON.stringify({ status: input.runStatus, errorCode: input.safeErrorCode }),
        input.now,
        input.runId,
        input.userId,
        input.runStatus,
        input.safeErrorCode,
      ),
  ]);
  return getRunForUser(db, input.userId, input.runId);
}

export async function resolveUnknownAtFullReservation(
  db: D1Database,
  input: { userId: string; runId: string; stepId: string; now: number },
): Promise<StepRecord> {
  const current = await getStepForUser(db, input.userId, input.stepId);
  if (!current || current.runId !== input.runId) throw new Error("STEP_NOT_FOUND");
  if (current.status !== UNKNOWN_OUTCOME) throw new Error("STEP_NOT_UNKNOWN");
  if (current.actualMicrousd === current.reservedMicrousd) return current;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE steps SET actual_microusd = reserved_microusd,
           safe_error_code = 'UNKNOWN_RESOLVED_AT_MAX'
         WHERE id = ? AND run_id = ? AND user_id = ? AND status = 'UNKNOWN_OUTCOME'
           AND actual_microusd IS NULL`,
      )
      .bind(input.stepId, input.runId, input.userId),
    db
      .prepare(
        `UPDATE experiment_budget
         SET outstanding_microusd = outstanding_microusd - ?,
             reconciled_microusd = reconciled_microusd + ?,
             active_step_id = NULL, lease_expires_at = NULL,
             version = version + 1, updated_at = ?
         WHERE id = ? AND active_step_id = ? AND outstanding_microusd >= ?`,
      )
      .bind(
        current.reservedMicrousd,
        current.reservedMicrousd,
        input.now,
        EXPERIMENT_BUDGET_ID,
        input.stepId,
        current.reservedMicrousd,
      ),
    db
      .prepare(
        `UPDATE runs
         SET outstanding_microusd = outstanding_microusd - ?,
             reconciled_microusd = reconciled_microusd + ?,
             active_step_id = NULL, last_error_code = 'UNKNOWN_RESOLVED_AT_MAX',
             version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'UNKNOWN_OUTCOME'
           AND active_step_id = ? AND outstanding_microusd >= ?`,
      )
      .bind(
        current.reservedMicrousd,
        current.reservedMicrousd,
        input.now,
        input.runId,
        input.userId,
        input.stepId,
        current.reservedMicrousd,
      ),
    auditStatement(db, {
      id: `audit_${crypto.randomUUID()}`,
      userId: input.userId,
      runId: input.runId,
      stepId: input.stepId,
      eventType: "unknown_resolved_at_max",
      safeMetadata: { status: UNKNOWN_OUTCOME, actualMicrousd: current.reservedMicrousd },
      now: input.now,
      onlyIfStepExists: true,
    }),
  ]);
  if (changes(results[0]) !== 1 || changes(results[1]) !== 1 || changes(results[2]) !== 1) {
    throw new Error("UNKNOWN_RESOLUTION_INVARIANT_FAILED");
  }
  const resolved = await getStepForUser(db, input.userId, input.stepId);
  if (!resolved) throw new Error("UNKNOWN_RESOLUTION_READBACK_FAILED");
  return resolved;
}

export function toSafeRunSummary(run: RunRecord) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    currentAgent: run.currentAgent,
    callCount: run.callCount,
    handoffCount: run.handoffCount,
    visits: run.visits,
    maxCalls: run.maxCalls,
    maxHandoffs: run.maxHandoffs,
    maxVisitsPerAgent: run.maxVisitsPerAgent,
    tokenBudget: run.tokenBudget,
    reservedTokens: run.reservedTokens,
    usedTokens: run.usedTokens,
    outstandingMicrousd: run.outstandingMicrousd,
    reconciledMicrousd: run.reconciledMicrousd,
    stopRequested: run.stopRequested,
    lastErrorCode: run.lastErrorCode,
    deadlineAt: run.deadlineAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function mapRun(row: RunRow) {
  return {
    id: row.id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    mode: row.mode,
    objective: row.objective,
    acceptanceCriteria: row.acceptance_criteria,
    model: row.model,
    priceVersion: row.price_version,
    status: row.status,
    currentAgent: row.current_agent,
    callCount: row.call_count,
    handoffCount: row.handoff_count,
    visits: {
      researcher: row.researcher_visits,
      architect: row.architect_visits,
      coder: row.coder_visits,
      reviewer: row.reviewer_visits,
    },
    maxCalls: row.max_calls,
    maxHandoffs: row.max_handoffs,
    maxVisitsPerAgent: row.max_visits_per_agent,
    tokenBudget: row.token_budget,
    maxInputTokens: row.max_input_tokens,
    maxOutputTokens: row.max_output_tokens,
    runSpendCapMicrousd: row.run_spend_cap_microusd,
    reservedTokens: row.reserved_tokens,
    usedTokens: row.used_tokens,
    outstandingMicrousd: row.outstanding_microusd,
    reconciledMicrousd: row.reconciled_microusd,
    activeStepId: row.active_step_id,
    stopRequested: Boolean(row.stop_requested),
    version: row.version,
    deadlineAt: row.deadline_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStep(row: StepRow) {
  return {
    id: row.id,
    runId: row.run_id,
    userId: row.user_id,
    stepNumber: row.step_number,
    idempotencyKey: row.idempotency_key,
    agent: row.agent,
    status: row.status,
    nextAgent: row.next_agent,
    clientRequestId: row.client_request_id,
    providerRequestId: row.provider_request_id,
    providerResponseId: row.provider_response_id,
    reservedInputTokens: row.reserved_input_tokens,
    reservedOutputTokens: row.reserved_output_tokens,
    reservedMicrousd: row.reserved_microusd,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    totalTokens: row.total_tokens,
    actualMicrousd: row.actual_microusd,
    safeErrorCode: row.safe_error_code,
    retryAfterSeconds: row.retry_after_seconds,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapBudget(row: BudgetRow) {
  return {
    id: row.id,
    authorizedMicrousd: row.authorized_microusd,
    startThresholdMicrousd: row.start_threshold_microusd,
    outstandingMicrousd: row.outstanding_microusd,
    reconciledMicrousd: row.reconciled_microusd,
    activeStepId: row.active_step_id,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

async function reservationDenialReason(
  db: D1Database,
  input: ReserveStepInput,
): Promise<Extract<ReservationResult, { kind: "denied" }>["reason"]> {
  const row = await db
    .prepare("SELECT * FROM runs WHERE id = ? AND user_id = ?")
    .bind(input.runId, input.userId)
    .first<RunRow>();
  if (!row) return "RUN_NOT_FOUND";
  if (row.status !== RUNNING) return "RUN_TERMINAL";
  if (Boolean(row.stop_requested)) return "STOP_REQUESTED";
  if (row.deadline_at <= input.now) return "RUN_TIMEOUT";
  if (row.call_count >= row.max_calls) return "CALL_LIMIT";
  const visits = {
    researcher: row.researcher_visits,
    architect: row.architect_visits,
    coder: row.coder_visits,
    reviewer: row.reviewer_visits,
  } as Record<string, number>;
  if ((visits[row.current_agent] ?? row.max_visits_per_agent) >= row.max_visits_per_agent) return "VISIT_LIMIT";
  if (row.reserved_tokens + input.reservedInputTokens + input.reservedOutputTokens > row.token_budget) return "TOKEN_LIMIT";
  if (row.reconciled_microusd + row.outstanding_microusd + input.reservedMicrousd > row.run_spend_cap_microusd) return "RUN_COST_LIMIT";
  if (row.active_step_id) return "BUSY";
  const budget = await ensureExperimentBudget(db, input.now);
  if (budget.activeStepId) return "BUSY";
  if (budget.reconciledMicrousd + budget.outstandingMicrousd + input.reservedMicrousd >= budget.startThresholdMicrousd) return "PROJECT_SPEND_LIMIT";
  return "CONCURRENT_REQUEST";
}

function auditStatement(
  db: D1Database,
  input: {
    id: string;
    userId: string;
    runId: string;
    stepId: string;
    eventType: string;
    safeMetadata: Record<string, string | number | boolean | null>;
    now: number;
    onlyIfStepExists: boolean;
  },
) {
  const metadata = JSON.stringify(input.safeMetadata);
  if (input.onlyIfStepExists) {
    return db
      .prepare(
        `INSERT INTO audit_events (
          id, user_id, run_id, step_id, event_type, safe_metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM steps WHERE id = ? AND run_id = ? AND user_id = ?)`,
      )
      .bind(
        input.id,
        input.userId,
        input.runId,
        input.stepId,
        input.eventType,
        metadata,
        input.now,
        input.stepId,
        input.runId,
        input.userId,
      );
  }
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, user_id, run_id, step_id, event_type, safe_metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.runId,
      input.stepId,
      input.eventType,
      metadata,
      input.now,
    );
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

function validateCreateRun(input: CreateRunInput) {
  requireSafeText(input.userId, "userId", 256);
  requireSafeText(input.idempotencyKey, "idempotencyKey", 128);
  requireSafeText(input.mode, "mode", 32);
  requireSafeText(input.objective, "objective", 8_000);
  requireSafeText(input.acceptanceCriteria, "acceptanceCriteria", 8_000);
  requireSafeText(input.model, "model", 128);
  requireSafeText(input.priceVersion, "priceVersion", 128);
  for (const [label, value] of Object.entries({
    maxCalls: input.maxCalls,
    maxHandoffs: input.maxHandoffs,
    maxVisitsPerAgent: input.maxVisitsPerAgent,
    tokenBudget: input.tokenBudget,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    runSpendCapMicrousd: input.runSpendCapMicrousd,
    now: input.now,
    deadlineAt: input.deadlineAt,
  })) requireNonNegativeSafeInteger(value, label);
  if (input.maxCalls < 1 || input.maxVisitsPerAgent < 1) throw new TypeError("run limits must be positive");
  if (input.deadlineAt <= input.now) throw new TypeError("deadlineAt must be after now");
  validateExperimentBudgetConfig(input.experimentBudget);
  if (input.runSpendCapMicrousd > input.experimentBudget.startThresholdMicrousd) {
    throw new RangeError("run spend cap exceeds the internal project threshold");
  }
}

function validateReserveStep(input: ReserveStepInput) {
  requireSafeText(input.userId, "userId", 256);
  requireSafeText(input.runId, "runId", 128);
  requireSafeText(input.idempotencyKey, "idempotencyKey", 128);
  requireSafeText(input.expectedAgent, "expectedAgent", 32);
  requireSafeText(input.clientRequestId, "clientRequestId", 512);
  for (const [label, value] of Object.entries({
    reservedInputTokens: input.reservedInputTokens,
    reservedOutputTokens: input.reservedOutputTokens,
    reservedMicrousd: input.reservedMicrousd,
    now: input.now,
    leaseExpiresAt: input.leaseExpiresAt,
  })) requireNonNegativeSafeInteger(value, label);
  if (input.reservedMicrousd < 1) throw new TypeError("reservedMicrousd must be positive");
  if (input.leaseExpiresAt <= input.now) throw new TypeError("leaseExpiresAt must be after now");
}

function validateCommit(input: {
  userId: string;
  runId: string;
  stepId: string;
  providerResponseId: string;
  nextAgent: string;
  runStatus: string;
  usage: UsageForCommit;
  actualMicrousd: number;
  recordContentJson: string;
  now: number;
}) {
  requireSafeText(input.userId, "userId", 256);
  requireSafeText(input.runId, "runId", 128);
  requireSafeText(input.stepId, "stepId", 128);
  requireSafeText(input.providerResponseId, "providerResponseId", 256);
  requireSafeText(input.nextAgent, "nextAgent", 32);
  requireSafeText(input.runStatus, "runStatus", 64);
  if (!isRunStatus(input.runStatus)) throw new TypeError("runStatus is not recognized");
  requireSafeText(input.recordContentJson, "recordContentJson", 32_000);
  JSON.parse(input.recordContentJson);
  for (const [label, value] of Object.entries({
    ...input.usage,
    actualMicrousd: input.actualMicrousd,
    now: input.now,
  })) requireNonNegativeSafeInteger(value, label);
  if (input.usage.cachedInputTokens > input.usage.inputTokens) {
    throw new RangeError("cachedInputTokens exceeds inputTokens");
  }
  if (input.usage.reasoningTokens > input.usage.outputTokens) {
    throw new RangeError("reasoningTokens exceeds outputTokens");
  }
}

function sameCreateRequest(row: RunRow, input: CreateRunInput): boolean {
  return row.mode === input.mode &&
    row.objective === input.objective &&
    row.acceptance_criteria === input.acceptanceCriteria &&
    row.model === input.model &&
    row.price_version === input.priceVersion &&
    row.max_calls === input.maxCalls &&
    row.max_handoffs === input.maxHandoffs &&
    row.max_visits_per_agent === input.maxVisitsPerAgent &&
    row.token_budget === input.tokenBudget &&
    row.max_input_tokens === input.maxInputTokens &&
    row.max_output_tokens === input.maxOutputTokens &&
    row.run_spend_cap_microusd === input.runSpendCapMicrousd;
}

function requireTerminalStatus(status: string) {
  requireSafeText(status, "runStatus", 64);
  if (!isTerminalRunStatus(status)) throw new TypeError("runStatus must be a recognized terminal status");
}

function requireSafeIdentifier(value: string, label: string) {
  if (!/^[A-Z0-9_]{1,64}$/.test(value)) {
    throw new TypeError(`${label} must be an uppercase safe identifier`);
  }
}

function requireSafeText(value: string, label: string, maxLength: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string no longer than ${maxLength}`);
  }
}

function requireNonNegativeSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}
