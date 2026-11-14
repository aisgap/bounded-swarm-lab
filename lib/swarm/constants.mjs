export const ROLES = Object.freeze([
  "researcher",
  "architect",
  "coder",
  "reviewer",
]);

export const TRANSITIONS = Object.freeze({
  researcher: Object.freeze(["architect"]),
  architect: Object.freeze(["researcher", "coder"]),
  coder: Object.freeze(["architect", "reviewer"]),
  reviewer: Object.freeze(["coder", "DONE"]),
});

export const DEFAULT_LIMITS = Object.freeze({
  calls: 6,
  handoffs: 5,
  visitsPerRole: 2,
  tokenBudget: 24_000,
  inputTokenCap: 3_000,
  outputTokenCap: 1_000,
  runTimeoutMs: 60_000,
});

export const ABSOLUTE_LIMITS = Object.freeze({
  calls: Object.freeze({ min: 1, max: DEFAULT_LIMITS.calls }),
  handoffs: Object.freeze({ min: 0, max: DEFAULT_LIMITS.handoffs }),
  visitsPerRole: Object.freeze({ min: 1, max: DEFAULT_LIMITS.visitsPerRole }),
  tokenBudget: Object.freeze({ min: 1, max: DEFAULT_LIMITS.tokenBudget }),
  inputTokenCap: Object.freeze({ min: 1, max: DEFAULT_LIMITS.inputTokenCap }),
  outputTokenCap: Object.freeze({ min: 1, max: DEFAULT_LIMITS.outputTokenCap }),
  runTimeoutMs: Object.freeze({ min: 1, max: DEFAULT_LIMITS.runTimeoutMs }),
});

export const OFFLINE_SCENARIOS = Object.freeze([
  "success",
  "rework",
  "loop",
  "invalid",
  "failure",
]);

export function isRole(value) {
  return typeof value === "string" && ROLES.includes(value);
}

export function isAllowedTransition(role, target) {
  return isRole(role) && typeof target === "string" && TRANSITIONS[role].includes(target);
}
