import "server-only";

import {
  DEFAULT_LIMITS,
  PRICE_TABLE_VERSION,
  RUN_STATUS,
  TRANSITIONS,
  calculateUsageMicrousd,
  calculateWorstCaseMicrousd,
  isPricedModel,
} from "../swarm/index.mjs";
import type { CreateRunRequest, StepRunRequest } from "./contracts";
import { SafeHttpError } from "./http";
import {
  conservativeRequestInputTokens,
  invokeOpenAI,
  type OpenAIRequestShape,
  type ProviderFailureCode,
} from "./openai";
import { buildBoundedPrompt, PromptLimitError, type PromptRole } from "./prompt";
import {
  commitStepSuccess,
  createRun,
  ensureExperimentBudget,
  getRunForUser,
  getStepForUser,
  listRecordsForUser,
  markStepDispatching,
  markStepUnknown,
  recoverExpiredActiveStep,
  rejectStepKnown,
  requestRunStop,
  reserveStep,
  terminateRunBeforeDispatch,
  toSafeRunSummary,
  type RunRecord,
  type StepRecord,
} from "./repository";
import {
  configuredExperimentBudget,
  configuredModel,
  liveExecutionEnabled,
  openAIKeyConfigured,
  requireDatabase,
  requireOpenAIKey,
  type ExperimentBudgetConfig,
} from "./runtime";

const PROVIDER_TIMEOUT_MS = 20_000;
const MINIMUM_DISPATCH_WINDOW_MS = 2_000;
const DISPATCH_STALE_AFTER_MS = 60_000;
const COST_ROUNDING_SLACK_MICROUSD = 2;

type ServiceDependencies = {
  db?: D1Database;
  now?: () => number;
  liveEnabled?: boolean;
  model?: string;
  apiKey?: string;
  experimentBudget?: ExperimentBudgetConfig;
  invoke?: typeof invokeOpenAI;
};

export async function createLiveRun(
  userId: string,
  input: CreateRunRequest,
  dependencies: ServiceDependencies = {},
) {
  const context = resolveContext(dependencies, true);
  const now = context.now();
  const reservationMicrousd =
    calculateWorstCaseMicrousd(
      context.model,
      DEFAULT_LIMITS.inputTokenCap,
      DEFAULT_LIMITS.outputTokenCap,
    ) + COST_ROUNDING_SLACK_MICROUSD;
  try {
    const result = await createRun(context.db, {
      userId,
      idempotencyKey: input.idempotencyKey,
      mode: "LIVE_BOUNDED",
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      model: context.model,
      priceVersion: PRICE_TABLE_VERSION,
      maxCalls: DEFAULT_LIMITS.calls,
      maxHandoffs: DEFAULT_LIMITS.handoffs,
      maxVisitsPerAgent: DEFAULT_LIMITS.visitsPerRole,
      tokenBudget: DEFAULT_LIMITS.tokenBudget,
      maxInputTokens: DEFAULT_LIMITS.inputTokenCap,
      maxOutputTokens: DEFAULT_LIMITS.outputTokenCap,
      runSpendCapMicrousd: reservationMicrousd * DEFAULT_LIMITS.calls,
      experimentBudget: context.experimentBudget,
      now,
      deadlineAt: now + DEFAULT_LIMITS.runTimeoutMs,
    });
    return {
      created: result.created,
      run: await privateRunView(context.db, userId, result.run),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
      throw new SafeHttpError(
        409,
        "IDEMPOTENCY_CONFLICT",
        "That request identifier was already used for different run data.",
      );
    }
    throw error;
  }
}

export async function getLiveRun(
  userId: string,
  runId: string,
  dependencies: ServiceDependencies = {},
) {
  const db = dependencies.db ?? requireDatabase();
  const run = await getRunForUser(db, userId, runId);
  if (!run) throw new SafeHttpError(404, "RUN_NOT_FOUND", "The run was not found.");
  return privateRunView(db, userId, run);
}

export async function stopLiveRun(
  userId: string,
  runId: string,
  dependencies: ServiceDependencies = {},
) {
  const db = dependencies.db ?? requireDatabase();
  const now = (dependencies.now ?? Date.now)();
  const run = await requestRunStop(db, { userId, runId, now });
  if (!run) throw new SafeHttpError(404, "RUN_NOT_FOUND", "The run was not found.");
  return privateRunView(db, userId, run);
}

export async function stepLiveRun(
  userId: string,
  runId: string,
  input: StepRunRequest,
  dependencies: ServiceDependencies = {},
) {
  const context = resolveContext(dependencies, true);
  let now = context.now();
  await ensureExperimentBudget(context.db, now, context.experimentBudget);
  await recoverExpiredActiveStep(context.db, now);
  let run = await getRunForUser(context.db, userId, runId);
  if (!run) throw new SafeHttpError(404, "RUN_NOT_FOUND", "The run was not found.");
  if (run.status !== RUN_STATUS.RUNNING) {
    return { replayed: true, run: await privateRunView(context.db, userId, run) };
  }

  const role = requirePromptRole(run.currentAgent);
  const allowedNext = TRANSITIONS[role];
  const records = await readPromptRecords(context.db, userId, runId);
  let prompt;
  try {
    prompt = buildBoundedPrompt({
      role,
      objective: run.objective,
      acceptanceCriteria: run.acceptanceCriteria,
      records,
      maxBilledInputTokens: run.maxInputTokens,
    });
  } catch (error) {
    if (!(error instanceof PromptLimitError)) throw error;
    run = await stopBeforeDispatch(
      context.db,
      userId,
      runId,
      RUN_STATUS.INPUT_LIMIT,
      "INPUT_LIMIT",
      now,
    );
    return { replayed: false, run: await privateRunView(context.db, userId, run) };
  }

  const remainingMs = run.deadlineAt - now;
  if (remainingMs < MINIMUM_DISPATCH_WINDOW_MS) {
    run = await stopBeforeDispatch(
      context.db,
      userId,
      runId,
      RUN_STATUS.RUN_TIMEOUT,
      "RUN_TIMEOUT",
      now,
    );
    return { replayed: false, run: await privateRunView(context.db, userId, run) };
  }

  const clientRequestId = `swarm_${crypto.randomUUID()}`;
  const requestShape: OpenAIRequestShape = {
    model: run.model,
    role,
    allowedNext,
    instructions: prompt.instructions,
    serializedState: prompt.input,
    maxInputTokens: run.maxInputTokens,
    maxOutputTokens: run.maxOutputTokens,
    clientRequestId,
  };
  if (conservativeRequestInputTokens(requestShape) > run.maxInputTokens) {
    run = await stopBeforeDispatch(
      context.db,
      userId,
      runId,
      RUN_STATUS.INPUT_LIMIT,
      "INPUT_LIMIT",
      now,
    );
    return { replayed: false, run: await privateRunView(context.db, userId, run) };
  }

  const reservedMicrousd =
    calculateWorstCaseMicrousd(
      run.model,
      run.maxInputTokens,
      run.maxOutputTokens,
    ) + COST_ROUNDING_SLACK_MICROUSD;
  const reservation = await reserveStep(context.db, {
    runId,
    userId,
    idempotencyKey: input.idempotencyKey,
    expectedAgent: role,
    clientRequestId,
    reservedInputTokens: run.maxInputTokens,
    reservedOutputTokens: run.maxOutputTokens,
    reservedMicrousd,
    now,
    leaseExpiresAt: now + Math.min(PROVIDER_TIMEOUT_MS, remainingMs) + 5_000,
  });

  if (reservation.kind === "denied") {
    return handleReservationDenial(context.db, userId, runId, reservation.reason, now);
  }

  let step = reservation.step;
  if (reservation.kind === "existing" && step.status !== "RESERVED") {
    if (step.status === "DISPATCHING" && now - step.startedAt >= DISPATCH_STALE_AFTER_MS) {
      step = await markStepUnknown(context.db, {
        userId,
        runId,
        stepId: step.id,
        safeErrorCode: "STALE_DISPATCH_UNKNOWN",
        now,
      });
    }
    run = (await getRunForUser(context.db, userId, runId)) ?? run;
    return {
      replayed: true,
      step: safeStepSummary(step),
      run: await privateRunView(context.db, userId, run),
    };
  }

  const dispatching = await markStepDispatching(context.db, {
    userId,
    runId,
    stepId: step.id,
    now,
  });
  if (!dispatching) {
    step = (await getStepForUser(context.db, userId, step.id)) ?? step;
    run = (await getRunForUser(context.db, userId, runId)) ?? run;
    return {
      replayed: true,
      step: safeStepSummary(step),
      run: await privateRunView(context.db, userId, run),
    };
  }
  step = dispatching;

  const provider = await context.invoke({
    apiKey: context.apiKey,
    ...requestShape,
    clientRequestId: step.clientRequestId,
    timeoutMs: Math.min(PROVIDER_TIMEOUT_MS, remainingMs),
  });
  now = context.now();

  if (!provider.ok) {
    if (mustRetainReservation(provider.code, provider.outcomeUnknown)) {
      step = await markStepUnknown(context.db, {
        userId,
        runId,
        stepId: step.id,
        safeErrorCode: provider.code,
        providerRequestId: provider.providerRequestId,
        now,
      });
    } else {
      step = await rejectStepKnown(context.db, {
        userId,
        runId,
        stepId: step.id,
        runStatus: failureRunStatus(provider.code),
        safeErrorCode: provider.code,
        providerRequestId: provider.providerRequestId,
        retryAfterSeconds: provider.retryAfterSeconds,
        now,
      });
    }
    run = (await getRunForUser(context.db, userId, runId)) ?? run;
    return {
      replayed: false,
      step: safeStepSummary(step),
      run: await privateRunView(context.db, userId, run),
    };
  }

  const actualMicrousd = calculateUsageMicrousd(run.model, provider.usage).totalMicrousd;
  const latestRun = (await getRunForUser(context.db, userId, runId)) ?? run;
  const final = finalRunTransition(latestRun, provider.result.next, now);
  try {
    step = await commitStepSuccess(context.db, {
      userId,
      runId,
      stepId: step.id,
      providerRequestId: provider.providerRequestId,
      providerResponseId: provider.providerResponseId,
      nextAgent: provider.result.next,
      runStatus: final.status,
      incrementHandoff: final.incrementHandoff,
      usage: provider.usage,
      actualMicrousd,
      recordContentJson: JSON.stringify(provider.result),
      now,
    });
  } catch (error) {
    try {
      await markStepUnknown(context.db, {
        userId,
        runId,
        stepId: step.id,
        safeErrorCode: "COMMIT_OUTCOME_UNKNOWN",
        providerRequestId: provider.providerRequestId,
        now,
      });
    } catch {
      // The durable reservation and DISPATCHING state remain fail-closed.
    }
    throw error;
  }

  run = (await getRunForUser(context.db, userId, runId)) ?? run;
  return {
    replayed: false,
    step: safeStepSummary(step),
    run: await privateRunView(context.db, userId, run),
  };
}

export async function experimentStatus(dependencies: ServiceDependencies = {}) {
  const db = dependencies.db ?? requireDatabase();
  const now = (dependencies.now ?? Date.now)();
  const experimentBudget = dependencies.experimentBudget ?? configuredExperimentBudget();
  const budget = await ensureExperimentBudget(db, now, experimentBudget);
  const model = dependencies.model ?? configuredModel();
  const nextReservationMicrousd = isPricedModel(model)
    ? calculateWorstCaseMicrousd(
        model,
        DEFAULT_LIMITS.inputTokenCap,
        DEFAULT_LIMITS.outputTokenCap,
      ) + COST_ROUNDING_SLACK_MICROUSD
    : null;
  return {
    liveEnabled: dependencies.liveEnabled ?? liveExecutionEnabled(),
    providerConfigured: dependencyKeyConfigured(dependencies),
    model,
    nextReservationMicrousd,
    limits: DEFAULT_LIMITS,
    budget: {
      authorizedMicrousd: budget.authorizedMicrousd,
      startThresholdMicrousd: budget.startThresholdMicrousd,
      outstandingMicrousd: budget.outstandingMicrousd,
      reconciledMicrousd: budget.reconciledMicrousd,
      dispatchActive: Boolean(budget.activeStepId),
    },
  };
}

export function mustRetainReservation(
  code: ProviderFailureCode,
  outcomeUnknown: boolean,
): boolean {
  if (outcomeUnknown) return true;
  return new Set<ProviderFailureCode>([
    "UNKNOWN_OUTCOME",
    "USAGE_UNKNOWN",
    "ACCOUNTING_MISMATCH",
    "REFUSED",
    "INCOMPLETE_RESPONSE",
    "INVALID_RESPONSE",
    "PROVIDER_SERVER_ERROR",
    "PROVIDER_OVERLOADED",
  ]).has(code);
}

export function failureRunStatus(code: ProviderFailureCode): string {
  switch (code) {
    case "AUTHENTICATION_FAILED":
      return RUN_STATUS.AUTH_ERROR;
    case "BUDGET_STOP":
    case "BILLING_STOP":
      return RUN_STATUS.PROJECT_SPEND_LIMIT;
    case "RATE_LIMITED":
      return RUN_STATUS.RATE_LIMIT;
    case "PROVIDER_OVERLOADED":
      return RUN_STATUS.PROVIDER_OVERLOAD;
    case "PROVIDER_SERVER_ERROR":
      return RUN_STATUS.PROVIDER_ERROR;
    case "INCOMPLETE_RESPONSE":
      return RUN_STATUS.OUTPUT_LIMIT;
    case "INVALID_RESPONSE":
      return RUN_STATUS.MALFORMED_RESPONSE;
    default:
      return RUN_STATUS.PROVIDER_REJECTED;
  }
}

function resolveContext(dependencies: ServiceDependencies, requireLive: boolean) {
  const liveEnabled = dependencies.liveEnabled ?? liveExecutionEnabled();
  if (requireLive && !liveEnabled) {
    throw new SafeHttpError(503, "LIVE_DISABLED", "Live experiments are currently disabled.");
  }
  if (requireLive && !dependencyKeyConfigured(dependencies)) {
    throw new SafeHttpError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "The provider credential is not configured.",
    );
  }
  const model = dependencies.model ?? configuredModel();
  if (!isPricedModel(model)) {
    throw new SafeHttpError(503, "MODEL_NOT_ALLOWED", "The configured model is not approved.");
  }
  return {
    db: dependencies.db ?? requireDatabase(),
    now: dependencies.now ?? Date.now,
    model,
    apiKey: dependencies.apiKey ?? requireOpenAIKey(),
    experimentBudget: dependencies.experimentBudget ?? configuredExperimentBudget(),
    invoke: dependencies.invoke ?? invokeOpenAI,
  };
}

function dependencyKeyConfigured(dependencies: ServiceDependencies): boolean {
  if (dependencies.apiKey !== undefined) return dependencies.apiKey.length > 0;
  return openAIKeyConfigured();
}

async function privateRunView(db: D1Database, userId: string, run: RunRecord) {
  const records = await listRecordsForUser(db, userId, run.id);
  const activeStep = run.activeStepId
    ? await getStepForUser(db, userId, run.activeStepId)
    : null;
  return {
    ...toSafeRunSummary(run),
    objective: run.objective,
    acceptanceCriteria: run.acceptanceCriteria,
    model: run.model,
    priceVersion: run.priceVersion,
    maxInputTokens: run.maxInputTokens,
    maxOutputTokens: run.maxOutputTokens,
    runSpendCapMicrousd: run.runSpendCapMicrousd,
    activeStep: activeStep ? safeStepSummary(activeStep) : null,
    records: records.map((record) => ({
      sequence: record.sequence,
      author: record.author,
      content: parseStoredRecord(record.contentJson),
      createdAt: record.createdAt,
    })),
  };
}

function safeStepSummary(step: StepRecord) {
  return {
    id: step.id,
    stepNumber: step.stepNumber,
    agent: step.agent,
    status: step.status,
    nextAgent: step.nextAgent,
    providerRequestId: step.providerRequestId,
    reservedInputTokens: step.reservedInputTokens,
    reservedOutputTokens: step.reservedOutputTokens,
    reservedMicrousd: step.reservedMicrousd,
    inputTokens: step.inputTokens,
    cachedInputTokens: step.cachedInputTokens,
    outputTokens: step.outputTokens,
    reasoningTokens: step.reasoningTokens,
    totalTokens: step.totalTokens,
    actualMicrousd: step.actualMicrousd,
    safeErrorCode: step.safeErrorCode,
    retryAfterSeconds: step.retryAfterSeconds,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };
}

async function readPromptRecords(db: D1Database, userId: string, runId: string) {
  const stored = await listRecordsForUser(db, userId, runId);
  return stored.map((item) => {
    const parsed = parseStoredRecord(item.contentJson);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { record?: unknown }).record !== "string") {
      throw new Error("STORED_RECORD_INVALID");
    }
    return { author: item.author, record: (parsed as { record: string }).record };
  });
}

function parseStoredRecord(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { error: "STORED_RECORD_UNAVAILABLE" };
  }
}

function requirePromptRole(value: string): PromptRole {
  if (value === "researcher" || value === "architect" || value === "coder" || value === "reviewer") {
    return value;
  }
  throw new Error("INVALID_ACTIVE_ROLE");
}

async function stopBeforeDispatch(
  db: D1Database,
  userId: string,
  runId: string,
  status: string,
  errorCode: string,
  now: number,
): Promise<RunRecord> {
  const run = await terminateRunBeforeDispatch(db, {
    userId,
    runId,
    runStatus: status,
    safeErrorCode: errorCode,
    now,
  });
  if (!run) throw new SafeHttpError(404, "RUN_NOT_FOUND", "The run was not found.");
  return run;
}

async function handleReservationDenial(
  db: D1Database,
  userId: string,
  runId: string,
  reason: string,
  now: number,
) {
  if (reason === "RUN_NOT_FOUND") {
    throw new SafeHttpError(404, "RUN_NOT_FOUND", "The run was not found.");
  }
  if (reason === "BUSY" || reason === "CONCURRENT_REQUEST") {
    throw new SafeHttpError(409, "DISPATCH_BUSY", "Another bounded provider step is already active.");
  }
  const mapping: Record<string, string> = {
    STOP_REQUESTED: RUN_STATUS.USER_STOPPED,
    RUN_TIMEOUT: RUN_STATUS.RUN_TIMEOUT,
    CALL_LIMIT: RUN_STATUS.CALL_LIMIT,
    VISIT_LIMIT: RUN_STATUS.VISIT_LIMIT,
    TOKEN_LIMIT: RUN_STATUS.TOKEN_LIMIT,
    RUN_COST_LIMIT: RUN_STATUS.COST_LIMIT,
    PROJECT_SPEND_LIMIT: RUN_STATUS.PROJECT_SPEND_LIMIT,
  };
  const status = mapping[reason];
  if (status) {
    const run = await stopBeforeDispatch(db, userId, runId, status, reason, now);
    return { replayed: false, run: await privateRunView(db, userId, run) };
  }
  const run = await getRunForUser(db, userId, runId);
  if (!run) throw new SafeHttpError(404, "RUN_NOT_FOUND", "The run was not found.");
  return { replayed: true, run: await privateRunView(db, userId, run) };
}

function finalRunTransition(run: RunRecord, nextAgent: string, now: number) {
  if (run.stopRequested) return { status: RUN_STATUS.USER_STOPPED, incrementHandoff: false };
  if (now >= run.deadlineAt) return { status: RUN_STATUS.RUN_TIMEOUT, incrementHandoff: false };
  if (nextAgent === "DONE") return { status: RUN_STATUS.COMPLETE, incrementHandoff: false };
  if (run.handoffCount >= run.maxHandoffs) {
    return { status: RUN_STATUS.HANDOFF_LIMIT, incrementHandoff: false };
  }
  return { status: RUN_STATUS.RUNNING, incrementHandoff: true };
}
