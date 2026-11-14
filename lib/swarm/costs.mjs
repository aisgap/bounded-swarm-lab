const MICRO_USD_PER_USD = 1_000_000n;
const TOKENS_PER_MILLION = 1_000_000n;

function price(inputUsd, cachedInputUsd, outputUsd) {
  return Object.freeze({
    inputMicrousdPerMillion: BigInt(Math.round(inputUsd * Number(MICRO_USD_PER_USD))),
    cachedInputMicrousdPerMillion: BigInt(Math.round(cachedInputUsd * Number(MICRO_USD_PER_USD))),
    outputMicrousdPerMillion: BigInt(Math.round(outputUsd * Number(MICRO_USD_PER_USD))),
  });
}

// Standard-processing, short-context rates verified against
// https://developers.openai.com/api/docs/pricing on 2026-11-14.
export const PRICE_TABLE_VERSION = "openai-standard-2026-11-14";

export const MODEL_PRICES = Object.freeze({
  "gpt-6-luna": price(0.1, 0.01, 0.5),
  "gpt-6.1-terra": price(1, 0.05, 5),
  "gpt-6.1-sol": price(2, 0.1, 10),
  "gpt-6-astra": price(10, 1, 50),
});

export function isPricedModel(value) {
  return typeof value === "string" && Object.hasOwn(MODEL_PRICES, value);
}

function requireTokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return BigInt(value);
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function charge(tokens, rate) {
  return ceilDiv(tokens * rate, TOKENS_PER_MILLION);
}

function safeNumber(value) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("cost exceeds safe integer range");
  return Number(value);
}

export function calculateUsageMicrousd(model, usage) {
  if (!isPricedModel(model)) throw new RangeError(`model is not in the price allowlist: ${model}`);
  if (!usage || typeof usage !== "object") throw new TypeError("usage is required");

  const inputTokens = requireTokenCount(usage.inputTokens, "inputTokens");
  const cachedInputTokens = requireTokenCount(usage.cachedInputTokens ?? 0, "cachedInputTokens");
  const outputTokens = requireTokenCount(usage.outputTokens, "outputTokens");
  if (cachedInputTokens > inputTokens) throw new RangeError("cachedInputTokens cannot exceed inputTokens");

  const rates = MODEL_PRICES[model];
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const inputMicrousd = charge(uncachedInputTokens, rates.inputMicrousdPerMillion);
  const cachedInputMicrousd = charge(cachedInputTokens, rates.cachedInputMicrousdPerMillion);
  const outputMicrousd = charge(outputTokens, rates.outputMicrousdPerMillion);
  const totalMicrousd = inputMicrousd + cachedInputMicrousd + outputMicrousd;

  return Object.freeze({
    priceTableVersion: PRICE_TABLE_VERSION,
    model,
    inputMicrousd: safeNumber(inputMicrousd),
    cachedInputMicrousd: safeNumber(cachedInputMicrousd),
    outputMicrousd: safeNumber(outputMicrousd),
    totalMicrousd: safeNumber(totalMicrousd),
  });
}

export function calculateWorstCaseMicrousd(model, inputTokenCap, outputTokenCap) {
  return calculateUsageMicrousd(model, {
    inputTokens: inputTokenCap,
    cachedInputTokens: 0,
    outputTokens: outputTokenCap,
  }).totalMicrousd;
}

export function canReserveMicrousd({ reconciledMicrousd, outstandingMicrousd, requestedMicrousd, startThresholdMicrousd }) {
  const values = { reconciledMicrousd, outstandingMicrousd, requestedMicrousd, startThresholdMicrousd };
  for (const [label, value] of Object.entries(values)) requireTokenCount(value, label);
  // The experiment has a $10 hard ceiling, but new work stops before the
  // internal $9 guardrail. Equality is intentionally rejected so a dispatch
  // can never begin once the guardrail has been reached.
  return reconciledMicrousd + outstandingMicrousd + requestedMicrousd < startThresholdMicrousd;
}
