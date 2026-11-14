import "server-only";

const MAX_PROVIDER_BODY_BYTES = 256 * 1024;
const MAX_INSTRUCTIONS_BYTES = 16 * 1024;
const MAX_SERIALIZED_STATE_BYTES = 64 * 1024;
const MAX_API_KEY_BYTES = 2 * 1024;
const MAX_INPUT_TOKENS = 3_000;
const MAX_OUTPUT_TOKENS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

export const PROVIDER_FAILURE_CODE = Object.freeze({
  INVALID_PROVIDER_REQUEST: "INVALID_PROVIDER_REQUEST",
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  PERMISSION_OR_POLICY_DENIED: "PERMISSION_OR_POLICY_DENIED",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  BUDGET_STOP: "BUDGET_STOP",
  BILLING_STOP: "BILLING_STOP",
  RATE_LIMITED: "RATE_LIMITED",
  PROVIDER_SERVER_ERROR: "PROVIDER_SERVER_ERROR",
  PROVIDER_OVERLOADED: "PROVIDER_OVERLOADED",
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  REFUSED: "REFUSED",
  INCOMPLETE_RESPONSE: "INCOMPLETE_RESPONSE",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  USAGE_UNKNOWN: "USAGE_UNKNOWN",
  ACCOUNTING_MISMATCH: "ACCOUNTING_MISMATCH",
  UNKNOWN_OUTCOME: "UNKNOWN_OUTCOME",
} as const);

export type ProviderFailureCode =
  (typeof PROVIDER_FAILURE_CODE)[keyof typeof PROVIDER_FAILURE_CODE];

export type ModelStep = {
  next: string;
  record: string;
  findings: string[];
  evidence: Array<{ claim: string; source: string }>;
  uncertainty: string[];
};

export type ProviderUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type ProviderSuccess = {
  ok: true;
  result: ModelStep;
  usage: ProviderUsage;
  providerRequestId: string | null;
  providerResponseId: string;
  processingMs: number | null;
};

export type ProviderFailure = {
  ok: false;
  code: ProviderFailureCode;
  providerRequestId: string | null;
  retryAfterSeconds: number | null;
  outcomeUnknown: boolean;
};

export type ProviderResult = ProviderSuccess | ProviderFailure;

export type OpenAIInvocation = {
  apiKey: string;
  model: string;
  role: string;
  allowedNext: readonly string[];
  instructions: string;
  serializedState: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  clientRequestId: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

export type OpenAIRequestShape = Omit<
  OpenAIInvocation,
  "apiKey" | "timeoutMs" | "fetchImpl"
>;

/**
 * Executes exactly one bounded Responses API request. This function never retries.
 * The caller must persist its reservation and dispatch intent before invoking it.
 */
export async function invokeOpenAI(args: OpenAIInvocation): Promise<ProviderResult> {
  if (!validInvocation(args)) return failure(PROVIDER_FAILURE_CODE.INVALID_PROVIDER_REQUEST);

  const requestBody = JSON.stringify(buildRequestBody(args));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("provider_timeout"), args.timeoutMs);
  const fetchImpl = args.fetchImpl ?? fetch;

  let response: Response;
  let raw: string;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
        "x-client-request-id": args.clientRequestId,
      },
      body: requestBody,
      signal: controller.signal,
    });

    const body = await readBodyLimited(response);
    if (body.readFailed) {
      return failure(
        PROVIDER_FAILURE_CODE.UNKNOWN_OUTCOME,
        safeProviderIdentifier(response.headers.get("x-request-id")),
        null,
        true,
      );
    }
    if (body.tooLarge) {
      return failure(
        response.ok ? PROVIDER_FAILURE_CODE.USAGE_UNKNOWN : mapHttpError(response.status, null),
        safeProviderIdentifier(response.headers.get("x-request-id")),
        parseRetryAfter(response.headers.get("retry-after")),
      );
    }
    raw = body.text;
  } catch {
    return failure(PROVIDER_FAILURE_CODE.UNKNOWN_OUTCOME, null, null, true);
  } finally {
    clearTimeout(timeout);
  }

  const providerRequestId = safeProviderIdentifier(response.headers.get("x-request-id"));
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
  const processingMs = parseIntegerHeader(response.headers.get("openai-processing-ms"));

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return failure(
      response.ok ? PROVIDER_FAILURE_CODE.INVALID_RESPONSE : mapHttpError(response.status, null),
      providerRequestId,
      retryAfterSeconds,
    );
  }

  if (!response.ok) {
    return failure(
      mapHttpError(response.status, readErrorCode(payload)),
      providerRequestId,
      retryAfterSeconds,
    );
  }

  if (!isPlainObject(payload)) {
    return failure(PROVIDER_FAILURE_CODE.INVALID_RESPONSE, providerRequestId, retryAfterSeconds);
  }
  if (payload.status !== "completed") {
    return failure(
      payload.status === "incomplete" || payload.incomplete_details
        ? PROVIDER_FAILURE_CODE.INCOMPLETE_RESPONSE
        : PROVIDER_FAILURE_CODE.INVALID_RESPONSE,
      providerRequestId,
      retryAfterSeconds,
    );
  }
  if (payload.error || payload.incomplete_details) {
    return failure(
      payload.incomplete_details
        ? PROVIDER_FAILURE_CODE.INCOMPLETE_RESPONSE
        : PROVIDER_FAILURE_CODE.INVALID_RESPONSE,
      providerRequestId,
      retryAfterSeconds,
    );
  }
  if (payload.service_tier !== "default") {
    return failure(PROVIDER_FAILURE_CODE.USAGE_UNKNOWN, providerRequestId, retryAfterSeconds);
  }

  const outputText = extractOutputText(payload.output);
  if (!outputText.ok) {
    return failure(
      outputText.refused ? PROVIDER_FAILURE_CODE.REFUSED : PROVIDER_FAILURE_CODE.INVALID_RESPONSE,
      providerRequestId,
      retryAfterSeconds,
    );
  }

  let modelResult: unknown;
  try {
    modelResult = JSON.parse(outputText.text);
  } catch {
    return failure(PROVIDER_FAILURE_CODE.INVALID_RESPONSE, providerRequestId, retryAfterSeconds);
  }
  const result = parseModelStep(modelResult, args.allowedNext);
  if (!result) {
    return failure(PROVIDER_FAILURE_CODE.INVALID_RESPONSE, providerRequestId, retryAfterSeconds);
  }

  const usage = parseUsage(payload.usage);
  if (!usage) {
    return failure(PROVIDER_FAILURE_CODE.USAGE_UNKNOWN, providerRequestId, retryAfterSeconds);
  }
  // Standard short-context pricing has no cache-write price. A non-zero write
  // count must retain the reservation rather than being silently undercharged.
  if (usage.cacheWriteTokens !== 0 || usage.cachedInputTokens !== 0) {
    return failure(PROVIDER_FAILURE_CODE.USAGE_UNKNOWN, providerRequestId, retryAfterSeconds);
  }
  if (
    usage.totalTokens !== usage.inputTokens + usage.outputTokens ||
    usage.cachedInputTokens > usage.inputTokens ||
    usage.reasoningTokens > usage.outputTokens ||
    usage.inputTokens > args.maxInputTokens ||
    usage.outputTokens > args.maxOutputTokens
  ) {
    return failure(PROVIDER_FAILURE_CODE.ACCOUNTING_MISMATCH, providerRequestId, retryAfterSeconds);
  }

  const providerResponseId = safeProviderIdentifier(payload.id);
  if (!providerResponseId) {
    return failure(PROVIDER_FAILURE_CODE.INVALID_RESPONSE, providerRequestId, retryAfterSeconds);
  }

  return {
    ok: true,
    result,
    usage,
    providerRequestId,
    providerResponseId,
    processingMs,
  };
}

export function conservativeRequestInputTokens(args: OpenAIRequestShape): number {
  // The entire serialized request is an intentionally conservative upper
  // bound for user-visible input, instructions, schema, and formatting. Every
  // token consumes at least one UTF-8 byte, while this also counts fields that
  // are not tokenized.
  return byteLength(JSON.stringify(buildRequestBody(args)));
}

function buildRequestBody(args: OpenAIRequestShape) {
  return {
    model: args.model,
    service_tier: "default",
    prompt_cache_options: { mode: "explicit" },
    instructions: args.instructions,
    input: args.serializedState,
    max_output_tokens: args.maxOutputTokens,
    store: false,
    stream: false,
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    text: {
      format: {
        type: "json_schema",
        name: "bounded_swarm_step",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["next", "record", "findings", "evidence", "uncertainty"],
          properties: {
            next: { type: "string", enum: [...args.allowedNext] },
            record: { type: "string" },
            findings: { type: "array", items: { type: "string" } },
            evidence: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["claim", "source"],
                properties: {
                  claim: { type: "string" },
                  source: { type: "string" },
                },
              },
            },
            uncertainty: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    metadata: {
      component: "bounded-swarm-lab",
      role: args.role,
      dispatch_id: args.clientRequestId,
    },
  };
}

function validInvocation(value: OpenAIInvocation): boolean {
  if (!value || typeof value !== "object") return false;
  if (!boundedSecret(value.apiKey)) return false;
  if (!safeId(value.model, 128) || !safeId(value.role, 32)) return false;
  if (!Array.isArray(value.allowedNext) || value.allowedNext.length < 1 || value.allowedNext.length > 8) return false;
  if (new Set(value.allowedNext).size !== value.allowedNext.length) return false;
  if (!value.allowedNext.every((candidate) => safeId(candidate, 32))) return false;
  if (!boundedText(value.instructions, MAX_INSTRUCTIONS_BYTES)) return false;
  if (!boundedText(value.serializedState, MAX_SERIALIZED_STATE_BYTES)) return false;
  if (!boundedInteger(value.maxInputTokens, 1, MAX_INPUT_TOKENS)) return false;
  if (!boundedInteger(value.maxOutputTokens, 1, MAX_OUTPUT_TOKENS)) return false;
  if (!safeId(value.clientRequestId, 512)) return false;
  if (!boundedInteger(value.timeoutMs, 1, MAX_TIMEOUT_MS)) return false;
  if (conservativeRequestInputTokens(value) > value.maxInputTokens) return false;
  return value.fetchImpl === undefined || typeof value.fetchImpl === "function";
}

function boundedSecret(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\r\n]/.test(value) &&
    byteLength(value) <= MAX_API_KEY_BYTES;
}

function safeId(value: unknown, maxLength: number): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maxLength &&
    SAFE_ID.test(value);
}

function safeProviderIdentifier(value: unknown): string | null {
  return safeId(value, 512) ? value : null;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && byteLength(value) <= maxBytes;
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseModelStep(value: unknown, allowedNext: readonly string[]): ModelStep | null {
  if (!hasExactKeys(value, ["next", "record", "findings", "evidence", "uncertainty"])) return null;
  if (typeof value.next !== "string" || !allowedNext.includes(value.next)) return null;
  if (!boundedTrimmedString(value.record, 2_000)) return null;
  if (!stringArray(value.findings, 8, 1_000)) return null;
  if (!stringArray(value.uncertainty, 8, 1_000)) return null;
  if (!Array.isArray(value.evidence) || value.evidence.length > 12) return null;
  const evidence: Array<{ claim: string; source: string }> = [];
  for (const item of value.evidence) {
    if (!hasExactKeys(item, ["claim", "source"])) return null;
    if (!boundedTrimmedString(item.claim, 1_000) || !boundedTrimmedString(item.source, 2_000)) return null;
    evidence.push({ claim: item.claim, source: item.source });
  }
  return {
    next: value.next,
    record: value.record,
    findings: [...value.findings],
    evidence,
    uncertainty: [...value.uncertainty],
  };
}

function stringArray(value: unknown, maxItems: number, maxStringLength: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => boundedTrimmedString(item, maxStringLength));
}

function boundedTrimmedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function parseUsage(value: unknown): ProviderUsage | null {
  if (!isPlainObject(value)) return null;
  const inputDetails = value.input_tokens_details;
  const outputDetails = value.output_tokens_details;
  if (inputDetails !== undefined && !isPlainObject(inputDetails)) return null;
  if (outputDetails !== undefined && !isPlainObject(outputDetails)) return null;

  const inputTokens = nonnegativeInteger(value.input_tokens);
  const cachedInputTokens = nonnegativeInteger(inputDetails?.cached_tokens ?? 0);
  const cacheWriteTokens = nonnegativeInteger(inputDetails?.cache_write_tokens ?? 0);
  const outputTokens = nonnegativeInteger(value.output_tokens);
  const reasoningTokens = nonnegativeInteger(outputDetails?.reasoning_tokens ?? 0);
  const totalTokens = nonnegativeInteger(value.total_tokens);
  if ([inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens].includes(null)) {
    return null;
  }
  return {
    inputTokens: inputTokens!,
    cachedInputTokens: cachedInputTokens!,
    cacheWriteTokens: cacheWriteTokens!,
    outputTokens: outputTokens!,
    reasoningTokens: reasoningTokens!,
    totalTokens: totalTokens!,
  };
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function extractOutputText(output: unknown): { ok: true; text: string } | { ok: false; refused: boolean } {
  if (!Array.isArray(output)) return { ok: false, refused: false };
  const messages = output.filter((item) => isPlainObject(item) && item.type === "message");
  if (messages.length !== 1) return { ok: false, refused: false };
  const message = messages[0];
  if (message.role !== "assistant" || !Array.isArray(message.content)) return { ok: false, refused: false };
  if (message.status !== undefined && message.status !== "completed") return { ok: false, refused: false };

  const texts: string[] = [];
  let refused = false;
  for (const content of message.content) {
    if (!isPlainObject(content)) continue;
    if (content.type === "refusal") refused = true;
    if (content.type === "output_text" && typeof content.text === "string") texts.push(content.text);
  }
  if (refused || texts.length !== 1) return { ok: false, refused };
  return { ok: true, text: texts[0] };
}

type LimitedBody =
  | { text: string; tooLarge: false; readFailed: false }
  | { tooLarge: true; readFailed: false }
  | { tooLarge: false; readFailed: true };

async function readBodyLimited(response: Response): Promise<LimitedBody> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_PROVIDER_BODY_BYTES) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return { tooLarge: true, readFailed: false };
  }
  if (!response.body) return { text: "", tooLarge: false, readFailed: false };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!item.value) continue;
      total += item.value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        return { tooLarge: true, readFailed: false };
      }
      chunks.push(item.value);
    }
  } catch {
    return { tooLarge: false, readFailed: true };
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(joined), tooLarge: false, readFailed: false };
  } catch {
    return { text: "", tooLarge: false, readFailed: false };
  }
}

function readErrorCode(payload: unknown): string | null {
  if (!isPlainObject(payload) || !isPlainObject(payload.error)) return null;
  if (typeof payload.error.code === "string") return payload.error.code;
  return typeof payload.error.type === "string" ? payload.error.type : null;
}

function mapHttpError(status: number, rawCode: string | null): ProviderFailureCode {
  const code = rawCode?.toLowerCase() ?? null;
  if (
    code === "project_spend_limit_exceeded" ||
    code === "organization_spend_limit_exceeded" ||
    code === "organization_usage_limit_exceeded"
  ) return PROVIDER_FAILURE_CODE.BUDGET_STOP;
  if (code === "credit_balance_exhausted") return PROVIDER_FAILURE_CODE.BILLING_STOP;
  if (status === 401) return PROVIDER_FAILURE_CODE.AUTHENTICATION_FAILED;
  if (status === 403) return PROVIDER_FAILURE_CODE.PERMISSION_OR_POLICY_DENIED;
  if (status === 404 || code === "model_not_found") return PROVIDER_FAILURE_CODE.MODEL_UNAVAILABLE;
  if (status === 503 || code === "server_is_overloaded") return PROVIDER_FAILURE_CODE.PROVIDER_OVERLOADED;
  if (status === 429 || code === "rate_limit_error" || code === "slow_down") {
    return PROVIDER_FAILURE_CODE.RATE_LIMITED;
  }
  if (status >= 500) return PROVIDER_FAILURE_CODE.PROVIDER_SERVER_ERROR;
  if (status === 400 || status === 422) return PROVIDER_FAILURE_CODE.INVALID_PROVIDER_REQUEST;
  return PROVIDER_FAILURE_CODE.PROVIDER_REJECTED;
}

function failure(
  code: ProviderFailureCode,
  providerRequestId: string | null = null,
  retryAfterSeconds: number | null = null,
  outcomeUnknown = false,
): ProviderFailure {
  return { ok: false, code, providerRequestId, retryAfterSeconds, outcomeUnknown };
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1_000));
}

function parseIntegerHeader(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
