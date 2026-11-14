import {
  ABSOLUTE_LIMITS,
  DEFAULT_LIMITS,
  OFFLINE_SCENARIOS,
  ROLES,
  isAllowedTransition,
} from "./constants.mjs";

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(value, keys) {
  return isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function validateLimits(value) {
  const errors = [];
  if (!hasExactKeys(value, Object.keys(DEFAULT_LIMITS))) {
    return ["limits must contain exactly the supported bounded fields"];
  }

  for (const [key, range] of Object.entries(ABSOLUTE_LIMITS)) {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate) || candidate < range.min || candidate > range.max) {
      errors.push(`${key} must be a whole number from ${range.min} to ${range.max}`);
    }
  }
  return errors;
}
export function assertLimits(value) {
  const errors = validateLimits(value);
  if (errors.length) throw new TypeError(errors.join("; "));
  return Object.freeze({ ...value });
}

export function assertDefaultLimits(value) {
  const limits = assertLimits(value);
  for (const [key, expected] of Object.entries(DEFAULT_LIMITS)) {
    if (limits[key] !== expected) throw new RangeError(`${key} is fixed at ${expected}`);
  }
  return limits;
}

export function validateOfflineConfig(value) {
  const errors = [];
  if (!isPlainObject(value)) return ["configuration must be an object"];
  if (typeof value.objective !== "string" || !value.objective.trim()) {
    errors.push("objective is required");
  }
  if (typeof value.criteria !== "string" || !value.criteria.trim()) {
    errors.push("acceptance criteria are required");
  }
  if (!OFFLINE_SCENARIOS.includes(value.scenario)) {
    errors.push("scenario is not supported");
  }
  errors.push(...validateLimits(value.limits));
  return errors;
}
export function validateAgentResult(value, role, outputTokenCap) {
  const errors = [];
  if (!ROLES.includes(role)) return ["active role is invalid"];
  if (!hasExactKeys(value, ["next", "record", "outputTokens"])) {
    return ["agent result must contain exactly next, record, and outputTokens"];
  }
  if (!isAllowedTransition(role, value.next)) errors.push("next agent is not permitted");
  if (typeof value.record !== "string" || !value.record.trim() || value.record.length > 2_000) {
    errors.push("record must be a non-empty string of at most 2000 characters");
  }
  if (!Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0 || value.outputTokens > outputTokenCap) {
    errors.push("outputTokens exceeds the bounded output capacity");
  }
  return errors;
}
