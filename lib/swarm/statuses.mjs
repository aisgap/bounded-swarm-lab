export const RUN_STATUS = Object.freeze({
  RUNNING: "RUNNING",
  COMPLETE: "COMPLETE",
  USER_STOPPED: "USER_STOPPED",
  CALL_LIMIT: "CALL_LIMIT",
  HANDOFF_LIMIT: "HANDOFF_LIMIT",
  VISIT_LIMIT: "VISIT_LIMIT",
  TOKEN_LIMIT: "TOKEN_LIMIT",
  COST_LIMIT: "COST_LIMIT",
  INPUT_LIMIT: "INPUT_LIMIT",
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  RUN_TIMEOUT: "RUN_TIMEOUT",
  AUTH_ERROR: "AUTH_ERROR",
  PROJECT_SPEND_LIMIT: "PROJECT_SPEND_LIMIT",
  RATE_LIMIT: "RATE_LIMIT",
  PROVIDER_OVERLOAD: "PROVIDER_OVERLOAD",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
  INVALID_HANDOFF: "INVALID_HANDOFF",
  UNKNOWN_OUTCOME: "UNKNOWN_OUTCOME",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

export const STEP_STATUS = Object.freeze({
  RESERVED: "RESERVED",
  DISPATCHING: "DISPATCHING",
  COMMITTED: "COMMITTED",
  HANDOFF_BLOCKED: "HANDOFF_BLOCKED",
  REJECTED: "REJECTED",
  UNKNOWN_OUTCOME: "UNKNOWN_OUTCOME",
});

const terminalRunStatuses = new Set(
  Object.values(RUN_STATUS).filter((status) => status !== RUN_STATUS.RUNNING),
);

export function isRunStatus(value) {
  return typeof value === "string" && Object.values(RUN_STATUS).includes(value);
}

export function isStepStatus(value) {
  return typeof value === "string" && Object.values(STEP_STATUS).includes(value);
}

export function isTerminalRunStatus(value) {
  return terminalRunStatuses.has(value);
}
