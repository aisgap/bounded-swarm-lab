const ALLOWED_FIELDS = Object.freeze([
  "event",
  "runId",
  "stepId",
  "clientRequestId",
  "providerRequestId",
  "providerResponseId",
  "status",
  "agent",
  "nextAgent",
  "model",
  "callCount",
  "handoffCount",
  "reservedTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
  "reservedMicrousd",
  "actualMicrousd",
  "latencyMs",
  "errorCode",
  "at",
]);

const FORBIDDEN_KEY_PATTERN = /(api.?key|authorization|objective|criteria|prompt|record|response.?body|file.?name|email|name|content|secret)/i;

function isSafeValue(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function buildOperationalEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("operational event input must be an object");
  }
  const event = {};
  for (const key of ALLOWED_FIELDS) {
    if (!Object.hasOwn(input, key) || input[key] === undefined) continue;
    if (!isSafeValue(input[key])) throw new TypeError(`${key} must be a scalar value`);
    event[key] = input[key];
  }
  if (typeof event.event !== "string" || !event.event) {
    throw new TypeError("event is required");
  }
  return Object.freeze(event);
}

export function assertOperationalEventSafe(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("operational event must be an object");
  }
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_FIELDS.includes(key) || FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new TypeError(`operational field is not allowed: ${key}`);
    }
    if (!isSafeValue(value)) throw new TypeError(`operational field is not scalar: ${key}`);
  }
  return true;
}

export { ALLOWED_FIELDS };
