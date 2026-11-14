export const LIVE_RUN_STATUSES = Object.freeze([
  "RUNNING",
  "COMPLETE",
  "USER_STOPPED",
  "CALL_LIMIT",
  "HANDOFF_LIMIT",
  "VISIT_LIMIT",
  "TOKEN_LIMIT",
  "COST_LIMIT",
  "INPUT_LIMIT",
  "OUTPUT_LIMIT",
  "RUN_TIMEOUT",
  "AUTH_ERROR",
  "PROJECT_SPEND_LIMIT",
  "RATE_LIMIT",
  "PROVIDER_OVERLOAD",
  "PROVIDER_REJECTED",
  "PROVIDER_ERROR",
  "MALFORMED_RESPONSE",
  "INVALID_HANDOFF",
  "UNKNOWN_OUTCOME",
  "INTERNAL_ERROR",
]);

const TERMINAL_LIVE_STATUSES = new Set(
  LIVE_RUN_STATUSES.filter((status) => status !== "RUNNING"),
);

export function isTerminalLiveStatus(value) {
  return TERMINAL_LIVE_STATUSES.has(value);
}

export function formatMicrousd(value) {
  if (!Number.isSafeInteger(value) || value < 0) return "$—";
  return `$${(value / 1_000_000).toFixed(6)}`;
}

export function liveReadiness(health) {
  if (!isPlainObject(health)) {
    return readiness(false, "Provider status is unavailable.");
  }
  if (health.liveEnabled !== true) {
    return readiness(false, "Live execution is disabled.");
  }
  if (health.providerConfigured !== true) {
    return readiness(false, "The provider credential is not configured.");
  }
  const budget = health.budget;
  if (
    !isPlainObject(budget) ||
    !nonnegativeInteger(budget.authorizedMicrousd) ||
    !nonnegativeInteger(budget.reconciledMicrousd) ||
    !nonnegativeInteger(budget.outstandingMicrousd) ||
    !nonnegativeInteger(budget.startThresholdMicrousd)
  ) {
    return readiness(false, "Budget status is unavailable.");
  }
  if (budget.authorizedMicrousd === 0 && budget.startThresholdMicrousd === 0) {
    return readiness(false, "No live experiment budget is authorized.");
  }
  if (
    !positiveInteger(budget.authorizedMicrousd) ||
    !positiveInteger(budget.startThresholdMicrousd) ||
    budget.startThresholdMicrousd > budget.authorizedMicrousd
  ) {
    return readiness(false, "Budget status is unavailable.");
  }
  if (budget.dispatchActive === true) {
    return readiness(false, "Another provider call is active.");
  }
  if (!positiveInteger(health.nextReservationMicrousd)) {
    return readiness(false, "The configured provider model is not available for bounded dispatch.");
  }
  const committedMicrousd = budget.reconciledMicrousd + budget.outstandingMicrousd;
  if (!Number.isSafeInteger(committedMicrousd)) {
    return readiness(false, "Budget status is unavailable.");
  }
  if (committedMicrousd + health.nextReservationMicrousd >= budget.startThresholdMicrousd) {
    return readiness(false, "The experiment budget threshold has been reached.");
  }
  return readiness(true, "Live provider is ready.");
}

export function mergeLiveRun(current, incoming) {
  if (!isRun(incoming)) return current;
  if (!isRun(current)) return incoming;
  if (current.id !== incoming.id) return incoming;
  if (isTerminalLiveStatus(current.status) && !isTerminalLiveStatus(incoming.status)) {
    return current;
  }
  const currentUpdatedAt = validTimestamp(current.updatedAt);
  const incomingUpdatedAt = validTimestamp(incoming.updatedAt);
  if (
    currentUpdatedAt !== null &&
    incomingUpdatedAt !== null &&
    incomingUpdatedAt < currentUpdatedAt
  ) {
    return current;
  }
  return { ...current, ...incoming };
}

export function buildRedactedLiveReceipt(run) {
  if (!isRun(run)) return null;
  return {
    schemaVersion: 1,
    mode: "live-bounded",
    runId: run.id,
    status: run.status,
    currentAgent: safeString(run.currentAgent),
    stopRequested: run.stopRequested === true,
    counters: {
      calls: safeInteger(run.callCount),
      handoffs: safeInteger(run.handoffCount),
      visits: safeVisits(run.visits),
      reservedTokens: safeInteger(run.reservedTokens),
      usedTokens: safeInteger(run.usedTokens),
    },
    cost: {
      outstandingMicrousd: safeInteger(run.outstandingMicrousd),
      reconciledMicrousd: safeInteger(run.reconciledMicrousd),
    },
    limits: {
      maxCalls: safeInteger(run.maxCalls),
      maxHandoffs: safeInteger(run.maxHandoffs),
      maxVisitsPerAgent: safeInteger(run.maxVisitsPerAgent),
      tokenBudget: safeInteger(run.tokenBudget),
      maxInputTokens: safeInteger(run.maxInputTokens),
      maxOutputTokens: safeInteger(run.maxOutputTokens),
      runSpendCapMicrousd: safeInteger(run.runSpendCapMicrousd),
    },
    error: safeString(run.lastErrorCode),
    timestamps: {
      createdAt: safeInteger(run.createdAt),
      updatedAt: safeInteger(run.updatedAt),
      deadlineAt: safeInteger(run.deadlineAt),
    },
    activeStep: safeActiveStep(run.activeStep),
    redactionNotice:
      "Objective, acceptance criteria, records, model output, filenames, and provider bodies are intentionally omitted.",
  };
}

function readiness(ready, reason) {
  return { ready, reason };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRun(value) {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    LIVE_RUN_STATUSES.includes(value.status)
  );
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function safeInteger(value) {
  return nonnegativeInteger(value) ? value : null;
}

function validTimestamp(value) {
  return nonnegativeInteger(value) ? value : null;
}

function safeString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeVisits(value) {
  if (!isPlainObject(value)) return null;
  return {
    researcher: safeInteger(value.researcher),
    architect: safeInteger(value.architect),
    coder: safeInteger(value.coder),
    reviewer: safeInteger(value.reviewer),
  };
}

function safeActiveStep(value) {
  if (!isPlainObject(value)) return null;
  return {
    id: safeString(value.id),
    stepNumber: safeInteger(value.stepNumber),
    agent: safeString(value.agent),
    status: safeString(value.status),
    nextAgent: safeString(value.nextAgent),
    reservedMicrousd: safeInteger(value.reservedMicrousd),
    actualMicrousd: safeInteger(value.actualMicrousd),
    inputTokens: safeInteger(value.inputTokens),
    outputTokens: safeInteger(value.outputTokens),
    reasoningTokens: safeInteger(value.reasoningTokens),
    totalTokens: safeInteger(value.totalTokens),
    safeErrorCode: safeString(value.safeErrorCode),
  };
}
