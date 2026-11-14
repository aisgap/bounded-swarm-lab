import {
  DEFAULT_LIMITS,
  ROLES,
  TRANSITIONS,
} from "./constants.mjs";
import { RUN_STATUS, STEP_STATUS } from "./statuses.mjs";
import { validateAgentResult, validateOfflineConfig } from "./validation.mjs";

const SYNTHETIC_INPUT_TOKENS = 250;
const SYNTHETIC_OUTPUT_TOKENS = 100;

function clone(value) {
  return structuredClone(value);
}

function runId(now) {
  return globalThis.crypto?.randomUUID?.() ?? `offline-${now}`;
}

function stop(state, status) {
  state.status = status;
  state.completedAt = state.completedAt ?? state.updatedAt;
  return state;
}

function scriptedTarget(state, role) {
  const defaultTarget = {
    researcher: "architect",
    architect: "coder",
    coder: "reviewer",
    reviewer: "DONE",
  }[role];
  if (state.scenario === "loop" && role === "architect") return "researcher";
  if (state.scenario === "rework" && role === "reviewer" && state.visits.reviewer === 1) return "coder";
  if (state.scenario === "invalid" && role === "researcher") return "DONE";
  return defaultTarget;
}

function scriptedRecord(state, role, target) {
  return {
    researcher: "Fixture finding: a single active writer protects shared records.",
    architect: "Fixture design: immutable limits, allowlisted routing, and reservation before dispatch.",
    coder: state.visits.coder > 1
      ? "Fixture revision: added the requested trace evidence."
      : "Fixture implementation: prepared a bounded workflow.",
    reviewer: target === "coder"
      ? "Fixture review: one bounded revision is required."
      : "Fixture review: scripted acceptance reached; live quality remains unverified.",
  }[role];
}

export function createOfflineRun(config, now = Date.now()) {
  const candidate = {
    objective: config?.objective,
    criteria: config?.criteria,
    scenario: config?.scenario ?? "success",
    limits: config?.limits ?? DEFAULT_LIMITS,
  };
  const errors = validateOfflineConfig(candidate);
  if (errors.length) throw new TypeError(errors.join("; "));

  return {
    id: runId(now),
    mode: "OFFLINE_SCRIPTED",
    objective: candidate.objective.trim(),
    criteria: candidate.criteria.trim(),
    scenario: candidate.scenario,
    limits: Object.freeze({ ...candidate.limits }),
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    status: RUN_STATUS.RUNNING,
    currentRole: "researcher",
    calls: 0,
    handoffs: 0,
    reservedTokens: 0,
    usedTokens: 0,
    visits: Object.fromEntries(ROLES.map((role) => [role, 0])),
    trace: [],
    records: [],
  };
}

export function requestStop(run, now = Date.now()) {
  const state = clone(run);
  if (state.status === RUN_STATUS.RUNNING) {
    state.updatedAt = now;
    stop(state, RUN_STATUS.USER_STOPPED);
  }
  return state;
}

export function stepOfflineRun(run, now = Date.now()) {
  const state = clone(run);
  if (state.status !== RUN_STATUS.RUNNING) return state;
  state.updatedAt = now;

  const role = state.currentRole;
  const limits = state.limits;
  if (now - state.startedAt >= limits.runTimeoutMs) return stop(state, RUN_STATUS.RUN_TIMEOUT);
  if (state.calls >= limits.calls) return stop(state, RUN_STATUS.CALL_LIMIT);
  if (state.visits[role] >= limits.visitsPerRole) return stop(state, RUN_STATUS.VISIT_LIMIT);
  if (limits.inputTokenCap < SYNTHETIC_INPUT_TOKENS) return stop(state, RUN_STATUS.INPUT_LIMIT);
  if (limits.outputTokenCap < SYNTHETIC_OUTPUT_TOKENS) return stop(state, RUN_STATUS.OUTPUT_LIMIT);

  const reservation = SYNTHETIC_INPUT_TOKENS + limits.outputTokenCap;
  if (state.reservedTokens + reservation > limits.tokenBudget) return stop(state, RUN_STATUS.TOKEN_LIMIT);

  state.calls += 1;
  state.visits[role] += 1;
  state.reservedTokens += reservation;
  const event = {
    sequence: state.trace.length + 1,
    agent: role,
    reservation,
    status: STEP_STATUS.RESERVED,
    next: null,
    resultCommitted: false,
    handoffDispatched: false,
    at: new Date(now).toISOString(),
  };
  state.trace.push(event);

  if (state.scenario === "failure" && role === "coder") {
    event.status = STEP_STATUS.UNKNOWN_OUTCOME;
    return stop(state, RUN_STATUS.UNKNOWN_OUTCOME);
  }

  const target = scriptedTarget(state, role);
  const record = scriptedRecord(state, role, target);
  const result = { next: target, record, outputTokens: SYNTHETIC_OUTPUT_TOKENS };
  const errors = validateAgentResult(result, role, limits.outputTokenCap);
  if (errors.length) {
    event.status = STEP_STATUS.REJECTED;
    event.errorCode = "INVALID_AGENT_RESULT";
    return stop(state, target === "DONE" ? RUN_STATUS.INVALID_HANDOFF : RUN_STATUS.MALFORMED_RESPONSE);
  }

  state.usedTokens += SYNTHETIC_INPUT_TOKENS + SYNTHETIC_OUTPUT_TOKENS;
  state.records.push({
    sequence: state.records.length + 1,
    author: role,
    text: record,
  });
  event.next = target;
  event.resultCommitted = true;
  event.status = STEP_STATUS.COMMITTED;

  if (target === "DONE") return stop(state, RUN_STATUS.COMPLETE);
  if (state.handoffs >= limits.handoffs) {
    event.status = STEP_STATUS.HANDOFF_BLOCKED;
    return stop(state, RUN_STATUS.HANDOFF_LIMIT);
  }

  state.handoffs += 1;
  state.currentRole = target;
  event.handoffDispatched = true;
  return state;
}

export function runOfflineToTerminal(config, { startAt = 0, maxSteps = 100 } = {}) {
  let state = createOfflineRun(config, startAt);
  for (let index = 0; index < maxSteps && state.status === RUN_STATUS.RUNNING; index += 1) {
    state = stepOfflineRun(state, startAt + index);
  }
  return state;
}

export { SYNTHETIC_INPUT_TOKENS, SYNTHETIC_OUTPUT_TOKENS, TRANSITIONS };
