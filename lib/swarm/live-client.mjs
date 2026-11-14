const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function runIdFromSearch(search) {
  if (typeof search !== "string") return null;
  try {
    const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("run");
    return typeof value === "string" && RUN_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function createLiveClient({
  createRequest,
  stepRequest,
  stopRequest,
  getRequest,
  makeId = defaultId,
}) {
  for (const [name, value] of Object.entries({
    createRequest,
    stepRequest,
    stopRequest,
    getRequest,
    makeId,
  })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }

  let createInFlight = false;
  let createKey = null;
  let stepInFlight = false;
  let stopInFlight = false;
  let ambiguousRunId = null;

  async function createRun(input) {
    if (createInFlight) return ignored();
    createInFlight = true;
    createKey ??= idempotencyKey("web-run", makeId);
    try {
      const result = await createRequest({ ...input, idempotencyKey: createKey });
      createKey = null;
      ambiguousRunId = null;
      return success(result);
    } catch (error) {
      // Retain the key. A later explicit create action can safely replay the
      // same logical mutation if the first response was lost.
      return failure(error);
    } finally {
      createInFlight = false;
    }
  }

  async function stepRun(runId) {
    requireRunId(runId);
    if (stepInFlight || ambiguousRunId === runId) {
      return { ...ignored(), ambiguous: ambiguousRunId === runId };
    }
    stepInFlight = true;
    try {
      const result = await stepRequest(runId, {
        idempotencyKey: idempotencyKey("web-step", makeId),
      });
      return success(result);
    } catch (error) {
      ambiguousRunId = runId;
      let reconciliation = null;
      let reconciliationError = null;
      try {
        // A failed step transport is never retried. Exactly one read-only
        // lookup is allowed to recover durable state.
        reconciliation = await getRequest(runId);
      } catch (readError) {
        reconciliationError = readError;
      }
      return {
        ...failure(error),
        ambiguous: true,
        reconciliation,
        reconciliationError,
      };
    } finally {
      stepInFlight = false;
    }
  }

  async function stopRun(runId) {
    requireRunId(runId);
    if (stopInFlight) return ignored();
    stopInFlight = true;
    try {
      const result = await stopRequest(runId, {
        idempotencyKey: idempotencyKey("web-stop", makeId),
      });
      return success(result);
    } catch (error) {
      return failure(error);
    } finally {
      stopInFlight = false;
    }
  }

  return Object.freeze({
    createRun,
    stepRun,
    stopRun,
    resetCreateKey() {
      if (!createInFlight) createKey = null;
    },
    resetForNewRun() {
      if (!stepInFlight) ambiguousRunId = null;
    },
    isStepBlocked(runId) {
      return stepInFlight || ambiguousRunId === runId;
    },
  });
}

function idempotencyKey(prefix, makeId) {
  const value = makeId();
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("makeId must return a non-empty string");
  }
  return `${prefix}-${value}`;
}

function defaultId() {
  return crypto.randomUUID();
}

function requireRunId(value) {
  if (typeof value !== "string" || !RUN_ID_PATTERN.test(value)) {
    throw new TypeError("runId is invalid");
  }
}

function ignored() {
  return { ignored: true, ok: false };
}

function success(result) {
  return { ignored: false, ok: true, result };
}

function failure(error) {
  return { ignored: false, ok: false, error };
}
