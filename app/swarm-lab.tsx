"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  buildRedactedLiveReceipt,
  formatMicrousd,
  liveReadiness,
  mergeLiveRun,
} from "@/lib/swarm/live-ui.mjs";
import { createLiveClient, runIdFromSearch } from "@/lib/swarm/live-client.mjs";
import { USE_CASE_PRESETS } from "@/lib/swarm/use-cases.mjs";

type RoleId = "researcher" | "architect" | "coder" | "reviewer";
type ScenarioId = "success" | "rework" | "loop" | "invalid" | "failure";
type ExecutionMode = "offline" | "live";
type RunStatus =
  | "READY"
  | "RUNNING"
  | "COMPLETE"
  | "USER_STOPPED"
  | "CALL_LIMIT"
  | "HANDOFF_LIMIT"
  | "VISIT_LIMIT"
  | "TOKEN_LIMIT"
  | "COST_LIMIT"
  | "INPUT_LIMIT"
  | "OUTPUT_LIMIT"
  | "RUN_TIMEOUT"
  | "AUTH_ERROR"
  | "PROJECT_SPEND_LIMIT"
  | "RATE_LIMIT"
  | "PROVIDER_OVERLOAD"
  | "PROVIDER_REJECTED"
  | "PROVIDER_ERROR"
  | "MALFORMED_RESPONSE"
  | "INVALID_HANDOFF"
  | "UNKNOWN_OUTCOME"
  | "INTERNAL_ERROR";

type LiveHealth = {
  liveEnabled: boolean;
  providerConfigured: boolean;
  model: string;
  nextReservationMicrousd: number | null;
  limits: {
    calls: number;
    handoffs: number;
    visitsPerRole: number;
    tokenBudget: number;
    inputTokenCap: number;
    outputTokenCap: number;
    runTimeoutMs: number;
  };
  budget: {
    authorizedMicrousd: number;
    startThresholdMicrousd: number;
    outstandingMicrousd: number;
    reconciledMicrousd: number;
    dispatchActive: boolean;
  };
};

type LiveStep = {
  id: string;
  stepNumber: number;
  agent: RoleId;
  status: string;
  nextAgent: RoleId | "DONE" | null;
  reservedMicrousd: number;
  actualMicrousd: number | null;
  totalTokens: number | null;
  safeErrorCode: string | null;
};

type LiveRecord = {
  sequence: number;
  author: RoleId;
  content: unknown;
  createdAt: number;
};

type LiveRun = {
  id: string;
  status: Exclude<RunStatus, "READY">;
  currentAgent: RoleId;
  callCount: number;
  handoffCount: number;
  visits: Record<RoleId, number>;
  maxCalls: number;
  maxHandoffs: number;
  maxVisitsPerAgent: number;
  tokenBudget: number;
  reservedTokens: number;
  usedTokens: number;
  outstandingMicrousd: number;
  reconciledMicrousd: number;
  stopRequested: boolean;
  lastErrorCode: string | null;
  deadlineAt: number;
  createdAt: number;
  updatedAt: number;
  records: LiveRecord[];
};

type ClientOutcome<T> = {
  ignored: boolean;
  ok: boolean;
  result?: T;
  error?: unknown;
  ambiguous?: boolean;
  reconciliation?: { run: LiveRun } | null;
  reconciliationError?: unknown;
};

type TraceKind = "work" | "handoff" | "guardrail" | "error" | "complete";

type TraceItem = {
  id: number;
  role: RoleId | "system";
  kind: TraceKind;
  title: string;
  detail: string;
};

type MemoryItem = {
  id: number;
  role: RoleId;
  title: string;
  content: string;
};

type RunSnapshot = {
  objective: string;
  acceptanceCriteria: string;
  scenario: ScenarioId;
  instructions: Record<RoleId, string>;
  attachmentNames: string[];
};

type RunState = {
  status: RunStatus;
  activeRole: RoleId | null;
  calls: number;
  handoffs: number;
  reservedTokens: number;
  elapsedSeconds: number;
  visits: Record<RoleId, number>;
  trace: TraceItem[];
  memory: MemoryItem[];
  runId: string | null;
  snapshot: RunSnapshot | null;
};

const ROLES: Array<{
  id: RoleId;
  name: string;
  short: string;
  purpose: string;
  route: string;
  color: string;
}> = [
  {
    id: "researcher",
    name: "Researcher",
    short: "RE",
    purpose: "Collects evidence and identifies uncertainty.",
    route: "Architect",
    color: "cyan",
  },
  {
    id: "architect",
    name: "Architect",
    short: "AR",
    purpose: "Shapes a plan and resolves missing context.",
    route: "Researcher or Coder",
    color: "violet",
  },
  {
    id: "coder",
    name: "Coder",
    short: "CO",
    purpose: "Builds the bounded implementation artifact.",
    route: "Architect or Reviewer",
    color: "amber",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    short: "RV",
    purpose: "Checks acceptance criteria and closes the run.",
    route: "Coder or Done",
    color: "mint",
  },
];

const DEFAULT_INSTRUCTIONS: Record<RoleId, string> = {
  researcher:
    "Summarize relevant facts, assumptions, and open questions. Hand off only to Architect.",
  architect:
    "Create a concise implementation plan. Ask Researcher for gaps or hand off a ready plan to Coder.",
  coder:
    "Produce the smallest complete artifact that meets the plan. Hand off to Reviewer when ready.",
  reviewer:
    "Evaluate the artifact against every acceptance criterion. Return concrete rework or mark Done.",
};

const LIMITS = {
  calls: 6,
  handoffs: 5,
  visits: 2,
  totalTokens: 24_000,
  inputTokens: 3_000,
  outputTokens: 1_000,
  timeoutSeconds: 60,
  concurrency: 1,
} as const;

const ALLOWED: Record<RoleId, Array<RoleId | "DONE">> = {
  researcher: ["architect"],
  architect: ["researcher", "coder"],
  coder: ["architect", "reviewer"],
  reviewer: ["coder", "DONE"],
};

const EMPTY_VISITS: Record<RoleId, number> = {
  researcher: 0,
  architect: 0,
  coder: 0,
  reviewer: 0,
};

const INITIAL_RUN: RunState = {
  status: "READY",
  activeRole: null,
  calls: 0,
  handoffs: 0,
  reservedTokens: 0,
  elapsedSeconds: 0,
  visits: EMPTY_VISITS,
  trace: [],
  memory: [],
  runId: null,
  snapshot: null,
};

const SCENARIOS: Array<{ id: ScenarioId; label: string; description: string }> = [
  { id: "success", label: "Clean success", description: "Four agents complete in sequence." },
  { id: "rework", label: "One rework loop", description: "Reviewer returns one bounded correction." },
  { id: "loop", label: "Visit limit", description: "A research loop is stopped by policy." },
  { id: "invalid", label: "Invalid handoff", description: "A disallowed route is rejected." },
  { id: "failure", label: "Provider failure", description: "A reserved call ends with unknown outcome." },
];

const STATUS_COPY: Record<RunStatus, string> = {
  READY: "Ready for a bounded run",
  RUNNING: "Bounded run in progress",
  COMPLETE: "Run completed within every bound",
  USER_STOPPED: "Run stopped by user",
  CALL_LIMIT: "Stopped at the call limit",
  HANDOFF_LIMIT: "Stopped at the handoff limit",
  VISIT_LIMIT: "Stopped at the per-agent visit limit",
  TOKEN_LIMIT: "Stopped before exceeding the token budget",
  COST_LIMIT: "Stopped before exceeding the run cost limit",
  INPUT_LIMIT: "Stopped before exceeding the input limit",
  OUTPUT_LIMIT: "Stopped at the output limit",
  RUN_TIMEOUT: "Stopped at the time limit",
  AUTH_ERROR: "Provider authentication failed safely",
  PROJECT_SPEND_LIMIT: "Provider project spend limit reached",
  RATE_LIMIT: "Provider rate limit reached",
  PROVIDER_OVERLOAD: "Provider temporarily overloaded",
  PROVIDER_REJECTED: "Provider rejected the request",
  PROVIDER_ERROR: "Provider returned a terminal error",
  MALFORMED_RESPONSE: "Provider response failed validation",
  INVALID_HANDOFF: "Stopped because a handoff was not allowed",
  UNKNOWN_OUTCOME: "Stopped because provider outcome is uncertain",
  INTERNAL_ERROR: "Stopped after an internal safety error",
};

function roleName(role: RoleId | "system") {
  if (role === "system") return "Guardrail";
  return ROLES.find((item) => item.id === role)?.name ?? role;
}

function nextRoute(
  scenario: ScenarioId,
  role: RoleId,
  visits: Record<RoleId, number>,
): RoleId | "DONE" {
  if (scenario === "invalid" && role === "researcher") return "DONE";
  if (scenario === "loop" && role === "architect") return "researcher";
  if (scenario === "rework" && role === "reviewer" && visits.reviewer === 1) {
    return "coder";
  }

  if (role === "researcher") return "architect";
  if (role === "architect") return "coder";
  if (role === "coder") return "reviewer";
  return "DONE";
}

function workSummary(role: RoleId, visit: number) {
  const iteration = visit > 1 ? " Revised after the bounded feedback loop." : "";
  const summaries: Record<RoleId, string> = {
    researcher: "Evidence packet created with assumptions and open questions.",
    architect: "Implementation sequence and verification checkpoints defined.",
    coder: "Candidate artifact assembled against the approved plan.",
    reviewer: "Acceptance criteria checked and disposition recorded.",
  };
  return `${summaries[role]}${iteration}`;
}

function stopWith(
  state: RunState,
  status: RunStatus,
  title: string,
  detail: string,
): RunState {
  return {
    ...state,
    status,
    activeRole: null,
    trace: [
      ...state.trace,
      { id: state.trace.length + 1, role: "system", kind: "guardrail", title, detail },
    ],
  };
}

function advanceOffline(state: RunState): RunState {
  if (state.status !== "RUNNING" || !state.activeRole) return state;
  const scenario = state.snapshot?.scenario ?? "success";
  if (state.elapsedSeconds >= LIMITS.timeoutSeconds) {
    return stopWith(state, "RUN_TIMEOUT", "Time limit reached", "No further work was started.");
  }
  if (state.calls >= LIMITS.calls) {
    return stopWith(state, "CALL_LIMIT", "Call limit reached", "The seventh call was never started.");
  }

  const role = state.activeRole;
  if (state.visits[role] >= LIMITS.visits) {
    return stopWith(
      state,
      "VISIT_LIMIT",
      `${roleName(role)} visit blocked`,
      `The ${LIMITS.visits}-visit allowance was already used.`,
    );
  }

  const reservation = 1_250;
  if (state.reservedTokens + reservation > LIMITS.totalTokens) {
    return stopWith(
      state,
      "TOKEN_LIMIT",
      "Token reservation blocked",
      "The next maximum reservation would exceed 24,000 tokens.",
    );
  }

  const calls = state.calls + 1;
  const reservedTokens = state.reservedTokens + reservation;
  const visits = { ...state.visits, [role]: state.visits[role] + 1 };
  const work = workSummary(role, visits[role]);
  const workEntry: TraceItem = {
    id: state.trace.length + 1,
    role,
    kind: "work",
    title: `${roleName(role)} completed call ${calls}`,
    detail: work,
  };

  if (scenario === "failure" && role === "coder") {
    return {
      ...state,
      calls,
      reservedTokens,
      visits,
      status: "UNKNOWN_OUTCOME",
      activeRole: null,
      trace: [
        ...state.trace,
        workEntry,
        {
          id: state.trace.length + 2,
          role: "system",
          kind: "error",
          title: "Simulated provider outcome unknown",
          detail: "The reservation is retained; automatic retry is disabled.",
        },
      ],
    };
  }

  const next = nextRoute(scenario, role, visits);
  if (!ALLOWED[role].includes(next)) {
    return {
      ...state,
      calls,
      reservedTokens,
      visits,
      status: "INVALID_HANDOFF",
      activeRole: null,
      trace: [
        ...state.trace,
        workEntry,
        {
          id: state.trace.length + 2,
          role: "system",
          kind: "guardrail",
          title: "Handoff rejected",
          detail: `${roleName(role)} is not permitted to route to ${next === "DONE" ? "Done" : roleName(next)}.`,
        },
      ],
    };
  }

  const memory: MemoryItem[] = [
    ...state.memory,
    {
      id: state.memory.length + 1,
      role,
      title: `${roleName(role)} · visit ${visits[role]}`,
      content: work,
    },
  ];

  if (next === "DONE") {
    return {
      ...state,
      calls,
      reservedTokens,
      visits,
      memory,
      status: "COMPLETE",
      activeRole: null,
      trace: [
        ...state.trace,
        workEntry,
        {
          id: state.trace.length + 2,
          role,
          kind: "complete",
          title: "Done accepted",
          detail: "Reviewer closed the run after the acceptance check.",
        },
      ],
    };
  }

  if (state.handoffs >= LIMITS.handoffs) {
    return {
      ...state,
      calls,
      reservedTokens,
      visits,
      memory,
      status: "HANDOFF_LIMIT",
      activeRole: null,
      trace: [
        ...state.trace,
        workEntry,
        {
          id: state.trace.length + 2,
          role: "system",
          kind: "guardrail",
          title: "Handoff limit reached",
          detail: "The next handoff was not recorded and no additional agent was started.",
        },
      ],
    };
  }

  const handoffs = state.handoffs + 1;
  const nextTrace: TraceItem[] = [
    ...state.trace,
    workEntry,
    {
      id: state.trace.length + 2,
      role,
      kind: "handoff",
      title: `${roleName(role)} → ${roleName(next)}`,
      detail: "Allowlisted route committed to the shared trace.",
    },
  ];

  return {
    ...state,
    calls,
    reservedTokens,
    visits,
    memory,
    handoffs,
    activeRole: next,
    trace: nextTrace,
  };
}

class SafeApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as
      | { code?: string; message?: string }
      | null;
    if (!response.ok) {
      throw new SafeApiError(
        payload?.code ?? `HTTP_${response.status}`,
        payload?.message ?? "The bounded request could not be completed.",
      );
    }
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

function postJson<T>(path: string, body: unknown, timeoutMs = 10_000) {
  return fetchJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, timeoutMs);
}

function isRoleId(value: unknown): value is RoleId {
  return value === "researcher" || value === "architect" || value === "coder" || value === "reviewer";
}

function recordText(content: unknown): string {
  if (!content || typeof content !== "object") return "Stored result is unavailable.";
  const value = (content as { record?: unknown }).record;
  return typeof value === "string" && value.trim() ? value : "Stored result is unavailable.";
}

function liveMemory(records: LiveRecord[]): MemoryItem[] {
  return records
    .filter((record) => isRoleId(record.author))
    .map((record) => ({
      id: record.sequence,
      role: record.author,
      title: `${roleName(record.author)} · committed record ${record.sequence}`,
      content: recordText(record.content),
    }));
}

function downloadJsonFile(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 1_000);
}

export function SwarmLab({ displayName }: { displayName: string }) {
  const [mode, setMode] = useState<ExecutionMode>("offline");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [objective, setObjective] = useState(
    "Create a release-ready implementation brief for a bounded four-agent workflow.",
  );
  const [criteria, setCriteria] = useState(
    "The result names all limits, explains every handoff, and ends with a verifiable disposition.",
  );
  const [scenario, setScenario] = useState<ScenarioId>("success");
  const [instructions, setInstructions] =
    useState<Record<RoleId, string>>(DEFAULT_INSTRUCTIONS);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [validationMessage, setValidationMessage] = useState(
    "Complete the brief, then validate or run the handoff simulation.",
  );
  const [activeTab, setActiveTab] = useState<"trace" | "memory">("trace");
  const [run, setRun] = useState<RunState>(INITIAL_RUN);
  const [health, setHealth] = useState<LiveHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthPending, setHealthPending] = useState(true);
  const [liveRun, setLiveRun] = useState<LiveRun | null>(null);
  const [liveTrace, setLiveTrace] = useState<TraceItem[]>([]);
  const [createPending, setCreatePending] = useState(false);
  const [stepPending, setStepPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [liveAmbiguous, setLiveAmbiguous] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const startLock = useRef(false);
  const liveClient = useRef<ReturnType<typeof createLiveClient> | null>(null);
  if (liveClient.current === null) {
    liveClient.current = createLiveClient({
      createRequest: (body: unknown) => postJson("/api/runs", body),
      stepRequest: (runId: string, body: unknown) => postJson(`/api/runs/${encodeURIComponent(runId)}/step`, body, 30_000),
      stopRequest: (runId: string, body: unknown) => postJson(`/api/runs/${encodeURIComponent(runId)}/stop`, body),
      getRequest: (runId: string) => fetchJson(`/api/runs/${encodeURIComponent(runId)}`),
      makeId: () => crypto.randomUUID(),
    });
  }

  const offlineRunning = run.status === "RUNNING";
  const liveRunning = liveRun?.status === "RUNNING";
  const actionPending = createPending || stepPending || stopPending || refreshPending;
  const inputsLocked = offlineRunning || Boolean(liveRunning) || actionPending;
  const readiness = useMemo(() => liveReadiness(health), [health]);
  const displayStatus: RunStatus = mode === "live" ? liveRun?.status ?? "READY" : run.status;
  const displayActiveRole = mode === "live" ? liveRun?.currentAgent ?? null : run.activeRole;
  const displayCalls = mode === "live" ? liveRun?.callCount ?? 0 : run.calls;
  const displayHandoffs = mode === "live" ? liveRun?.handoffCount ?? 0 : run.handoffs;
  const displayReservedTokens = mode === "live" ? liveRun?.reservedTokens ?? 0 : run.reservedTokens;
  const displayUsedTokens = mode === "live" ? liveRun?.usedTokens ?? 0 : 0;
  const displayVisits = mode === "live" ? liveRun?.visits ?? EMPTY_VISITS : run.visits;
  const displayRunId = mode === "live" ? liveRun?.id ?? null : run.runId;
  const displayTrace = mode === "live" ? liveTrace : run.trace;
  const displayMemory = mode === "live" ? liveMemory(liveRun?.records ?? []) : run.memory;
  const isTerminal = displayStatus !== "READY" && displayStatus !== "RUNNING";
  const liveElapsedSeconds = liveRun
    ? Math.max(0, Math.min(LIMITS.timeoutSeconds, Math.floor((clockMs - liveRun.createdAt) / 1_000)))
    : 0;
  const displayElapsedSeconds = mode === "live" ? liveElapsedSeconds : run.elapsedSeconds;

  const progress = useMemo(() => {
    if (displayStatus === "COMPLETE") return 100;
    return Math.min(96, Math.round((displayCalls / LIMITS.calls) * 100));
  }, [displayCalls, displayStatus]);

  useEffect(() => {
    if (!offlineRunning) return;
    const timer = window.setTimeout(() => {
      setRun((current) => advanceOffline(current));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [offlineRunning, run.calls]);

  useEffect(() => {
    if (!offlineRunning) startLock.current = false;
  }, [offlineRunning]);

  useEffect(() => {
    if (!offlineRunning) return;
    const timer = window.setInterval(() => {
      setRun((current) => {
        if (current.status !== "RUNNING") return current;
        const elapsedSeconds = current.elapsedSeconds + 1;
        if (elapsedSeconds >= LIMITS.timeoutSeconds) {
          return stopWith(
            { ...current, elapsedSeconds },
            "RUN_TIMEOUT",
            "Time limit reached",
            "No further work was started.",
          );
        }
        return { ...current, elapsedSeconds };
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [offlineRunning]);

  useEffect(() => {
    let cancelled = false;
    async function loadInitialState() {
      setHealthPending(true);
      try {
        const nextHealth = await fetchJson<LiveHealth & { ok: true }>("/api/health");
        if (cancelled) return;
        setHealth(nextHealth);
        setHealthError(null);
      } catch (error) {
        if (cancelled) return;
        setHealth(null);
        setHealthError(error instanceof Error ? error.message : "Provider status is unavailable.");
      } finally {
        if (!cancelled) setHealthPending(false);
      }

      const runId = runIdFromSearch(window.location.search);
      if (!runId) return;
      try {
        const recovered = await fetchJson<{ run: LiveRun }>(`/api/runs/${encodeURIComponent(runId)}`);
        if (cancelled) return;
        setMode("live");
        setLiveRun(recovered.run);
        setLiveTrace([{
          id: 1,
          role: "system",
          kind: "guardrail",
          title: "Live run recovered",
          detail: "Durable server state was restored without dispatching provider work.",
        }]);
        setValidationMessage("Recovered from the private ledger. No provider call was made.");
      } catch (error) {
        if (!cancelled) {
          setHealthError(error instanceof Error ? error.message : "The saved run could not be recovered.");
        }
      }
    }
    void loadInitialState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!liveRunning) return;
    const timer = window.setInterval(() => setClockMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [liveRunning]);

  function validateBrief() {
    const nextErrors: string[] = [];
    setRuntimeError(null);
    if (objective.trim().length < 12) {
      nextErrors.push("Objective must be at least 12 characters.");
    }
    if (criteria.trim().length < 12) {
      nextErrors.push("Acceptance criteria must be at least 12 characters.");
    }
    if (mode === "live" && /\[[^\]]+\]/.test(`${objective}\n${criteria}`)) {
      nextErrors.push("Replace every [bracketed placeholder] before creating a live run.");
    }
    if (mode === "offline") {
      for (const role of ROLES) {
        if (instructions[role.id].trim().length < 12) {
          nextErrors.push(`${role.name} instructions must be at least 12 characters.`);
        }
      }
    }
    setErrors(nextErrors);
    setValidationMessage(
      nextErrors.length === 0
        ? mode === "live"
          ? "Brief validated. Creating a run is free; each step requires one explicit click."
          : "Brief validated. The handoff simulation can start."
        : `${nextErrors.length} item${nextErrors.length === 1 ? "" : "s"} need attention.`,
    );
    return nextErrors.length === 0;
  }

  function startOfflineRun() {
    if (startLock.current) return;
    if (!validateBrief()) return;
    startLock.current = true;
    const runId = `offline-${Date.now().toString(36)}`;
    setActiveTab("trace");
    setRun({
      ...INITIAL_RUN,
      status: "RUNNING",
      activeRole: "researcher",
      runId,
      snapshot: {
        objective,
        acceptanceCriteria: criteria,
        scenario,
        instructions: { ...instructions },
        attachmentNames: [...fileNames],
      },
      visits: { ...EMPTY_VISITS },
      trace: [
        {
          id: 1,
          role: "system",
          kind: "guardrail",
          title: "Handoff simulation started",
          detail: "Fixed bounds locked. No API request or paid service will be used.",
        },
      ],
    });
  }

  function stopOfflineRun() {
    setRun((current) => {
      if (current.status !== "RUNNING") return current;
      return {
        ...current,
        status: "USER_STOPPED",
        activeRole: null,
        trace: [
          ...current.trace,
          {
            id: current.trace.length + 1,
            role: "system",
            kind: "guardrail",
            title: "Stop requested",
            detail: "The scripted handoff scheduler was cancelled; no new agent work will start.",
          },
        ],
      };
    });
  }

  function chooseMode(nextMode: ExecutionMode) {
    if (inputsLocked) return;
    if (nextMode === "live" && !readiness.ready && !liveRun) return;
    setMode(nextMode);
    setErrors([]);
    setRuntimeError(null);
    setValidationMessage(
      nextMode === "live"
        ? "Live mode is manually stepped. Each step can make at most one provider request."
        : "Complete the brief, then validate or run the handoff simulation.",
    );
    if (nextMode === "offline") {
      const url = new URL(window.location.href);
      url.searchParams.delete("run");
      window.history.replaceState({}, "", url);
    }
  }

  function applyPreset(preset: (typeof USE_CASE_PRESETS)[number]) {
    if (inputsLocked) return;
    setSelectedPreset(preset.id);
    liveClient.current?.resetCreateKey();
    setObjective(preset.objective);
    setCriteria(preset.acceptanceCriteria);
    setErrors([]);
    setRuntimeError(null);
    setValidationMessage(`${preset.title} loaded. Replace bracketed details before running.`);
  }

  async function refreshHealth() {
    if (healthPending) return;
    setHealthPending(true);
    try {
      const nextHealth = await fetchJson<LiveHealth & { ok: true }>("/api/health");
      setHealth(nextHealth);
      setHealthError(null);
    } catch (error) {
      setHealth(null);
      setHealthError(error instanceof Error ? error.message : "Provider status is unavailable.");
    } finally {
      setHealthPending(false);
    }
  }

  function acceptLiveRun(incoming: LiveRun) {
    setLiveRun((current) => mergeLiveRun(current, incoming) as LiveRun);
  }

  function rememberLiveRun(runId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("run", runId);
    window.history.replaceState({}, "", url);
  }

  async function createLiveRun() {
    if (!readiness.ready || !validateBrief() || !liveClient.current) return;
    setCreatePending(true);
    setLiveAmbiguous(false);
    const outcome = await liveClient.current.createRun({
      objective: objective.trim(),
      acceptanceCriteria: criteria.trim(),
    }) as ClientOutcome<{ created: boolean; run: LiveRun }>;
    if (outcome.ignored) return;
    setCreatePending(false);
    if (!outcome.ok || !outcome.result) {
      const message = outcome.error instanceof Error ? outcome.error.message : "The live run could not be created.";
      setRuntimeError(message);
      setValidationMessage("No provider step was requested.");
      return;
    }
    const result = outcome.result;
    liveClient.current.resetForNewRun();
    setMode("live");
    setLiveRun(result.run);
    setLiveTrace([{
      id: 1,
      role: "system",
      kind: "guardrail",
      title: result.created ? "Live run created" : "Existing live run recovered",
      detail: "No provider call was made. Fixed limits and the 60-second deadline are now locked.",
    }]);
    rememberLiveRun(result.run.id);
    setActiveTab("trace");
    setClockMs(Date.now());
    setValidationMessage("Run created without provider spend. Authorize the next role explicitly.");
    setRuntimeError(null);
  }

  async function refreshLiveRun() {
    if (!liveRun || refreshPending) return;
    setRefreshPending(true);
    try {
      const result = await fetchJson<{ run: LiveRun }>(`/api/runs/${encodeURIComponent(liveRun.id)}`);
      acceptLiveRun(result.run);
      setRuntimeError(null);
      setValidationMessage("Durable run state refreshed. No provider call was made.");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Run state could not be refreshed.");
      setValidationMessage(error instanceof Error ? error.message : "Run state could not be refreshed.");
    } finally {
      setRefreshPending(false);
    }
  }

  async function stepLiveRun() {
    if (!liveRun || liveRun.status !== "RUNNING" || liveAmbiguous || !liveClient.current) return;
    setStepPending(true);
    setErrors([]);
    setRuntimeError(null);
    const runId = liveRun.id;
    const role = liveRun.currentAgent;
    setValidationMessage(`One ${roleName(role)} provider request is in progress. It will not be retried.`);
    const outcome = await liveClient.current.stepRun(runId) as ClientOutcome<{
      replayed: boolean;
      step?: LiveStep;
      run: LiveRun;
    }>;
    if (outcome.ignored) return;
    setStepPending(false);
    if (outcome.ok && outcome.result) {
      const result = outcome.result;
      acceptLiveRun(result.run);
      setLiveTrace((current) => {
        const step = result.step;
        const committed = step?.status === "COMMITTED";
        const next: TraceItem = {
          id: current.length + 1,
          role,
          kind: committed ? "work" : result.run.status === "COMPLETE" ? "complete" : "guardrail",
          title: committed
            ? `${roleName(role)} committed step ${step.stepNumber}`
            : `${roleName(role)} step ended as ${result.run.status}`,
          detail: committed
            ? `${step.totalTokens ?? 0} tokens reconciled at ${formatMicrousd(step.actualMicrousd ?? 0)}; next route ${step.nextAgent === "DONE" ? "Done" : roleName(step.nextAgent ?? role)}.`
            : `No retry was attempted. ${step?.safeErrorCode ?? result.run.lastErrorCode ?? "The server state is authoritative."}`,
        };
        return [...current, next];
      });
      setValidationMessage(
        result.run.status === "RUNNING"
          ? "Step response reconciled. The current durable status is shown above."
          : STATUS_COPY[result.run.status],
      );
      void refreshHealth();
      return;
    }
    setLiveAmbiguous(true);
    setValidationMessage("The step response was ambiguous. It was not retried; one read-only reconciliation was attempted.");
    if (outcome.reconciliation?.run) acceptLiveRun(outcome.reconciliation.run);
    setLiveTrace((current) => [...current, {
      id: current.length + 1,
      role: "system",
      kind: "error",
      title: "Provider outcome required reconciliation",
      detail: "No retry was sent. The run is locked to Refresh or Stop for operator review.",
    }]);
    if (outcome.reconciliationError) {
      setRuntimeError(outcome.error instanceof Error ? outcome.error.message : "Provider outcome is unknown.");
    }
  }

  async function stopLiveRun() {
    if (!liveRun || liveRun.status !== "RUNNING" || !liveClient.current) return;
    setStopPending(true);
    const outcome = await liveClient.current.stopRun(liveRun.id) as ClientOutcome<{ run: LiveRun }>;
    if (outcome.ignored) return;
    setStopPending(false);
    if (!outcome.ok || !outcome.result) {
      const message = outcome.error instanceof Error ? outcome.error.message : "Stop could not be confirmed.";
      setRuntimeError(message);
      setValidationMessage(message);
      return;
    }
    acceptLiveRun(outcome.result.run);
    setLiveTrace((current) => [...current, {
      id: current.length + 1,
      role: "system",
      kind: "guardrail",
      title: "Stop committed",
      detail: "No future provider step can start. Any in-flight request remains subject to reconciliation.",
    }]);
    setValidationMessage("Stop is durable. No new provider work will start for this run.");
    setRuntimeError(null);
    void refreshHealth();
  }

  function exportReceipt() {
    if (mode === "live") {
      if (!liveRun) return;
      downloadJsonFile(`${liveRun.id}-receipt.json`, buildRedactedLiveReceipt(liveRun));
      return;
    }
    if (!run.runId || !run.snapshot) return;
    const snapshot = run.snapshot;
    const receipt = {
      schemaVersion: 1,
      mode: "offline-scripted",
      runId: run.runId,
      status: run.status,
      scenario: snapshot.scenario,
      objective: "[redacted by default]",
      objectiveCharacters: snapshot.objective.length,
      acceptanceCriteria: "[redacted by default]",
      acceptanceCriteriaCharacters: snapshot.acceptanceCriteria.length,
      roleInstructions: Object.fromEntries(
        ROLES.map((role) => [role.id, {
          value: "[redacted by default]",
          characters: snapshot.instructions[role.id].length,
        }]),
      ),
      attachments: snapshot.attachmentNames.map(() => "[filename redacted]"),
      redactionNotice: "This audit receipt describes the captured run snapshot but is intentionally not replayable.",
      limits: LIMITS,
      usage: {
        calls: run.calls,
        handoffs: run.handoffs,
        reservedTokens: run.reservedTokens,
        elapsedSeconds: run.elapsedSeconds,
        estimatedApiCostUsd: 0,
        actualApiCostUsd: 0,
      },
      trace: run.trace,
      memory: run.memory,
    };
    downloadJsonFile(`${run.runId}-receipt.json`, receipt);
  }

  function changeTabFromKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = activeTab === "trace" ? "memory" : "trace";
    setActiveTab(next);
    window.requestAnimationFrame(() => document.getElementById(`${next}-tab`)?.focus());
  }

  return (
    <main className="lab-shell">
      <header className="topbar">
        <div className="brand" aria-label="Bounded Swarm Lab">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>Bounded Swarm</strong>
            <small>Control lab</small>
          </span>
        </div>
        <div className="topbar-status">
          <span className="environment-pill"><i />{
            healthPending
              ? "Checking provider"
              : health?.providerConfigured
                ? health.liveEnabled ? "Provider ready" : "Provider connected · gate closed"
                : "Simulation-safe"
          }</span>
          <span className="identity" title={displayName}>
            <span aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
            {displayName}
          </span>
        </div>
      </header>

      <section className="workspace-heading" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Deterministic workspace</p>
          <h1 id="page-title">Plan the work. Bound the swarm.</h1>
          <p>
            Rehearse handoffs, or manually authorize one bounded provider step at a time.
          </p>
        </div>
        <div className="spend-summary" aria-label="Hosted experiment spend">
          <span>Hosted experiment ledger</span>
          <strong>{formatMicrousd(health?.budget.reconciledMicrousd ?? 0)} <small>reconciled</small></strong>
          <em>{formatMicrousd(health?.budget.authorizedMicrousd ?? 0)} configured ceiling</em>
        </div>
      </section>

      <div className="workspace-grid">
        <aside className="control-column" aria-label="Experiment setup">
          <section className="panel mode-panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">01 · Mode</p>
                <h2>Choose execution</h2>
              </div>
              <span className="lock-badge">{health?.providerConfigured ? "Provider connected" : "Locked safe"}</span>
            </div>
            <div className="mode-options" role="radiogroup" aria-label="Execution mode">
              <label className={`mode-option ${mode === "offline" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "offline"}
                  disabled={inputsLocked}
                  onChange={() => chooseMode("offline")}
                />
                <span className="mode-icon" aria-hidden="true">◎</span>
                <span>
                  <strong>Handoff Simulation</strong>
                  <small>Scripted · $0 · deterministic</small>
                </span>
                <b>{mode === "offline" ? "Active" : "Ready"}</b>
              </label>
              <label
                className={`mode-option ${mode === "live" ? "selected" : ""} ${!readiness.ready && !liveRun ? "disabled" : ""}`}
                aria-disabled={!readiness.ready && !liveRun}
              >
                <input
                  type="radio"
                  name="mode"
                  checked={mode === "live"}
                  disabled={inputsLocked || (!readiness.ready && !liveRun)}
                  onChange={() => chooseMode("live")}
                />
                <span className="mode-icon" aria-hidden="true">◇</span>
                <span>
                  <strong>Live experiment</strong>
                  <small>{health?.providerConfigured ? "Owner-controlled OpenAI project" : "Provider access not ready"}</small>
                </span>
                <b>{mode === "live" ? "Active" : readiness.ready ? "Ready" : "Locked"}</b>
              </label>
            </div>
            <p className="mode-note">
              {healthError ?? readiness.reason} Live mode never advances automatically.
            </p>
          </section>

          <section className="panel brief-panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">02 · Brief</p>
                <h2>Define the experiment</h2>
              </div>
              <span className="local-badge">{mode === "live" ? "Stored privately" : "Session only"}</span>
            </div>

            {mode === "live" && (
              <p className="data-warning" role="note">
                Use synthetic or low-sensitivity content only. Live objectives, criteria, and records persist privately; deletion controls are not available yet.
              </p>
            )}

            <p className="field-label" id="use-case-label">
              Use case <span>prefill only</span>
            </p>
            <div className="preset-grid" role="group" aria-labelledby="use-case-label">
              {USE_CASE_PRESETS.map((preset) => (
                <button
                  type="button"
                  key={preset.id}
                  className={`preset-card ${selectedPreset === preset.id ? "selected" : ""}`}
                  aria-pressed={selectedPreset === preset.id}
                  disabled={inputsLocked}
                  onClick={() => applyPreset(preset)}
                >
                  <strong>{preset.title}</strong>
                  <small>{preset.description}</small>
                </button>
              ))}
            </div>

            <label className="field-label" htmlFor="objective">
              Objective <span>required</span>
            </label>
            <textarea
              id="objective"
              value={objective}
              onChange={(event) => {
                setObjective(event.target.value);
                setSelectedPreset(null);
                liveClient.current?.resetCreateKey();
              }}
              disabled={inputsLocked}
              rows={3}
              maxLength={700}
            />
            <div className="field-meta"><span>Clear outcome, not a process</span><span>{objective.length}/700</span></div>

            <label className="field-label" htmlFor="criteria">
              Acceptance criteria <span>required</span>
            </label>
            <textarea
              id="criteria"
              value={criteria}
              onChange={(event) => {
                setCriteria(event.target.value);
                setSelectedPreset(null);
                liveClient.current?.resetCreateKey();
              }}
              disabled={inputsLocked}
              rows={3}
              maxLength={700}
            />
            <div className="field-meta"><span>Observable definition of done</span><span>{criteria.length}/700</span></div>

            <label className="field-label" htmlFor="attachments">
              Reference files <span>{mode === "live" ? "handoff only" : "optional"}</span>
            </label>
            <label className={`file-picker ${mode === "live" ? "disabled" : ""}`} htmlFor="attachments">
              <span aria-hidden="true">＋</span>
              <strong>Choose local references</strong>
              <small>{mode === "live" ? "The live provider receives no files or filenames." : "Names only in the handoff simulation; contents are never read or uploaded."}</small>
            </label>
            <input
              className="visually-hidden"
              id="attachments"
              type="file"
              multiple
              disabled={inputsLocked || mode === "live"}
              onChange={(event) =>
                setFileNames(Array.from(event.target.files ?? []).map((file) => file.name))
              }
            />
            {fileNames.length > 0 && (
              <ul className="file-list" aria-label="Selected reference file names">
                {fileNames.map((name, index) => <li key={`${name}-${index}`}>{name}</li>)}
              </ul>
            )}

            <label className="field-label" htmlFor="scenario">
              Handoff scenario
            </label>
            <select
              id="scenario"
              value={scenario}
              disabled={inputsLocked || mode === "live"}
              onChange={(event) => setScenario(event.target.value as ScenarioId)}
            >
              {SCENARIOS.map((item) => (
                <option key={item.id} value={item.id}>{item.label} — {item.description}</option>
              ))}
            </select>
          </section>

          <section className="panel roles-panel">
            <div className="section-heading">
              <div>
                <p className="section-kicker">03 · Roles</p>
                <h2>Constrain each agent</h2>
              </div>
            </div>
            <p className="mode-note">
              {mode === "live"
                ? "Live runs use fixed, reviewed server instructions. Browser text cannot expand agent authority."
                : "These instructions are captured in the immutable run snapshot, but the scripted handoff fixture does not interpret their wording."}
            </p>
            {mode === "offline" ? (
              <div className="role-editors">
                {ROLES.map((role) => (
                  <details key={role.id} className="role-editor">
                    <summary>
                      <span className={`role-token ${role.color}`}>{role.short}</span>
                      <span><strong>{role.name}</strong><small>Routes to {role.route}</small></span>
                      <i aria-hidden="true">⌄</i>
                    </summary>
                    <label htmlFor={`${role.id}-instructions`}>Handoff simulation instructions</label>
                    <textarea
                      id={`${role.id}-instructions`}
                      value={instructions[role.id]}
                      disabled={inputsLocked}
                      rows={4}
                      maxLength={900}
                      onChange={(event) =>
                        setInstructions((current) => ({ ...current, [role.id]: event.target.value }))
                      }
                    />
                    <p><strong>Permitted route:</strong> {role.route}. This policy cannot be edited.</p>
                  </details>
                ))}
              </div>
            ) : (
              <div className="fixed-role-note">
                {ROLES.map((role) => (
                  <span key={role.id}><b>{role.short}</b>{role.name} → {role.route}</span>
                ))}
              </div>
            )}
          </section>
        </aside>

        <section className="activity-column" aria-label="Run activity">
          <section className="panel bounds-panel" aria-labelledby="bounds-title">
            <div className="section-heading bounds-heading">
              <div>
                <p className="section-kicker">Fixed policy</p>
                <h2 id="bounds-title">Experiment bounds</h2>
              </div>
              <span className="immutable-badge">Read only</span>
            </div>
            <div className="limit-grid">
              <Limit value="6" label="Agent calls" />
              <Limit value="5" label="Handoffs" />
              <Limit value="2" label="Visits / role" />
              <Limit value="24k" label="Total tokens" />
              <Limit value="1" label="Concurrency" />
              <Limit value="60s" label="Wall time" />
            </div>
            <p className="bound-detail">
              Each call is pre-authorized for at most 3,000 input and 1,000 output tokens. A failed or uncertain call is never retried automatically.
            </p>
          </section>

          <section className="panel run-panel">
            <div className="run-toolbar">
              <div>
                <p className="section-kicker">Run control</p>
                <h2>{STATUS_COPY[displayStatus]}</h2>
                <p className="run-id">{displayRunId ? `Receipt ${displayRunId}` : "No run started"}</p>
              </div>
              <div className="run-actions">
                <button
                  className="button secondary"
                  type="button"
                  onClick={mode === "live" && liveRun ? refreshLiveRun : validateBrief}
                  disabled={mode === "live" && liveRun ? refreshPending : inputsLocked}
                >
                  {mode === "live" && liveRun ? refreshPending ? "Refreshing…" : "Refresh state" : "Validate"}
                </button>
                {mode === "offline" && !offlineRunning && (
                  <button className="button primary" type="button" onClick={startOfflineRun}>
                    {isTerminal ? "Run again" : "Run handoff simulation"}
                  </button>
                )}
                {mode === "offline" && offlineRunning && (
                  <button className="button stop" type="button" onClick={stopOfflineRun}>Stop now</button>
                )}
                {mode === "live" && !liveRunning && (
                  <button
                    className="button primary"
                    type="button"
                    onClick={createLiveRun}
                    disabled={!readiness.ready || createPending}
                  >
                    {createPending ? "Creating…" : liveRun ? "Create another · no API call" : "Create run · no API call"}
                  </button>
                )}
                {mode === "live" && liveRunning && (
                  <>
                    <button
                      className="button primary"
                      type="button"
                      onClick={stepLiveRun}
                      disabled={stepPending || stopPending || liveAmbiguous || !readiness.ready}
                    >
                      {stepPending
                        ? "Reconciling…"
                        : `Run ${roleName(liveRun?.currentAgent ?? "researcher")} · 1 call (max ${formatMicrousd(health?.nextReservationMicrousd ?? 802)})`}
                    </button>
                    <button className="button stop" type="button" onClick={stopLiveRun} disabled={stopPending}>
                      {stopPending ? "Stopping…" : "Stop now"}
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className={`status-strip status-${displayStatus.toLowerCase()}`} role="status" aria-live="polite" aria-atomic="true">
              <span className="status-pulse" aria-hidden="true" />
              <span><strong>{STATUS_COPY[displayStatus]}</strong><small>{validationMessage}</small></span>
              <b>{displayStatus}</b>
            </div>

            {errors.length > 0 && (
              <div className="validation-errors" role="alert">
                <strong>Check the brief</strong>
                <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
              </div>
            )}

            {runtimeError && (
              <div className="validation-errors" role="alert">
                <strong>Live request stopped</strong>
                <p>{runtimeError}</p>
              </div>
            )}

            <div className="agent-track" aria-label="Agent progress">
              {ROLES.map((role, index) => {
                const active = displayActiveRole === role.id && displayStatus === "RUNNING";
                const complete = displayVisits[role.id] > 0 && !active;
                return (
                  <div className="agent-step-wrap" key={role.id}>
                    <article className={`agent-card ${active ? "active" : ""} ${complete ? "visited" : ""}`}>
                      <div className={`role-token large ${role.color}`}>{role.short}</div>
                      <div>
                        <h3>{role.name}</h3>
                        <p>{role.purpose}</p>
                      </div>
                      <span>{active ? mode === "live" ? "Awaiting approval" : "Working" : displayVisits[role.id] > 0 ? `${displayVisits[role.id]} visit${displayVisits[role.id] > 1 ? "s" : ""}` : "Waiting"}</span>
                    </article>
                    {index < ROLES.length - 1 && <i className="track-line" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>

            <div className="progress-row">
              <div className="progress-label"><span>Bounded run progress</span><strong>{progress}%</strong></div>
              <div className="progress-track" aria-label={`${progress}% run progress`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>

            <div className="metrics-grid">
              <Metric value={`${displayCalls} / ${LIMITS.calls}`} label="Calls" />
              <Metric value={`${displayHandoffs} / ${LIMITS.handoffs}`} label="Handoffs" />
              <Metric value={`${displayReservedTokens.toLocaleString()} / 24k`} label={mode === "live" ? `${displayUsedTokens.toLocaleString()} used` : "Tokens reserved"} />
              <Metric value={`${displayElapsedSeconds}s / 60s`} label="Elapsed" />
              <Metric value={mode === "live" ? formatMicrousd(liveRun?.reconciledMicrousd ?? 0) : "$0.000000"} label={mode === "live" && (liveRun?.outstandingMicrousd ?? 0) > 0 ? `${formatMicrousd(liveRun?.outstandingMicrousd ?? 0)} outstanding` : "Reconciled cost"} accent />
            </div>
          </section>

          <section className="panel ledger-panel">
            <div className="tabs" role="tablist" aria-label="Run details">
              <button
                id="trace-tab"
                role="tab"
                type="button"
                aria-selected={activeTab === "trace"}
                aria-controls="trace-panel"
                tabIndex={activeTab === "trace" ? 0 : -1}
                onKeyDown={changeTabFromKeyboard}
                onClick={() => setActiveTab("trace")}
              >
                Trace <span>{displayTrace.length}</span>
              </button>
              <button
                id="memory-tab"
                role="tab"
                type="button"
                aria-selected={activeTab === "memory"}
                aria-controls="memory-panel"
                tabIndex={activeTab === "memory" ? 0 : -1}
                onKeyDown={changeTabFromKeyboard}
                onClick={() => setActiveTab("memory")}
              >
                Output <span>{displayMemory.length}</span>
              </button>
              <button className="export-button" type="button" onClick={exportReceipt} disabled={!displayRunId || displayStatus === "RUNNING"}>
                Export redacted receipt
              </button>
            </div>

            <div id="trace-panel" role="tabpanel" aria-labelledby="trace-tab" className="ledger-content" hidden={activeTab !== "trace"}>
              {displayTrace.length === 0 ? (
                <EmptyState title="No trace yet" detail={mode === "live" ? "Create a run, then authorize one role at a time." : "A validated handoff simulation will record scripted checkpoints, handoffs, and every guardrail decision here."} />
              ) : (
                <ol className="trace-list">
                  {displayTrace.map((item) => <TraceEntry item={item} key={item.id} />)}
                </ol>
              )}
            </div>
            <div id="memory-panel" role="tabpanel" aria-labelledby="memory-tab" className="ledger-content" hidden={activeTab !== "memory"}>
              {displayMemory.length === 0 ? (
                <EmptyState title="No output yet" detail={mode === "live" ? "Committed provider records will appear after an authorized step." : "Scripted handoff checkpoints will appear here; no task output is generated. They remain only in this page session."} />
              ) : (
                <div className="memory-list">
                  {displayMemory.map((item) => (
                    <article key={item.id} className="memory-entry">
                      <span>{roleName(item.role)}</span>
                      <h3>{item.title}</h3>
                      <p>{item.content}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="spend-panel" aria-labelledby="spend-title">
            <div>
              <p className="section-kicker">Live gate</p>
              <h2 id="spend-title">Live experiment cap: {formatMicrousd(health?.budget.authorizedMicrousd ?? 0)}</h2>
              <p>
                {(health?.budget.authorizedMicrousd ?? 0) > 0
                  ? "The deployment owner configured a bounded pilot ceiling. Live steps remain manual, pre-reserved, and unavailable while the launch gate is closed."
                  : "No provider spend is authorized. The deployment owner must explicitly configure the server-side pilot ceiling before Live can reserve work."}
              </p>
            </div>
            <div className="spend-meter">
              <div><span>Hosted reconciled + outstanding</span><strong>{formatMicrousd((health?.budget.reconciledMicrousd ?? 0) + (health?.budget.outstandingMicrousd ?? 0))}</strong></div>
              <div className="cost-track"><span style={{ width: `${Math.min(100, (((health?.budget.reconciledMicrousd ?? 0) + (health?.budget.outstandingMicrousd ?? 0)) / (health?.budget.startThresholdMicrousd || 1)) * 100)}%` }} /></div>
              <small>{formatMicrousd(health?.budget.startThresholdMicrousd ?? 0)} maximum start threshold · {formatMicrousd(health?.budget.authorizedMicrousd ?? 0)} configured ceiling</small>
            </div>
            <button type="button" onClick={refreshHealth} disabled={healthPending}>{healthPending ? "Checking…" : "Refresh provider status"}</button>
          </section>

          <aside className="safety-notice">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>{mode === "live" ? "Manual provider control" : "Handoff rehearsal"}</strong>
              <p>{mode === "live"
                ? "Each step requires a click, makes at most one provider request, and is never retried automatically. Files and browser storage remain unused."
                : "No API calls, credentials, file contents, browser storage, background work, or automatic retries are used by the handoff simulation. It generates scripted checkpoints, not task output."}</p>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

function Limit({ value, label }: { value: string; label: string }) {
  return (
    <div className="limit-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Metric({ value, label, accent = false }: { value: string; label: string; accent?: boolean }) {
  return (
    <div className={`metric ${accent ? "accent" : ""}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TraceEntry({ item }: { item: TraceItem }) {
  return (
    <li className={`trace-entry trace-${item.kind}`}>
      <span className="trace-index">{String(item.id).padStart(2, "0")}</span>
      <div>
        <p><strong>{item.title}</strong><span>{roleName(item.role)}</span></p>
        <small>{item.detail}</small>
      </div>
    </li>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">⌁</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
