import "server-only";
import { env } from "cloudflare:workers";

export const EXPERIMENT_BUDGET_ID = "initial-openai-experiments-v1";
export const MAX_AUTHORIZED_EXPERIMENT_MICROUSD = 10_000_000;

export type ExperimentBudgetConfig = {
  authorizedMicrousd: number;
  startThresholdMicrousd: number;
};

type BudgetEnvironment = {
  SWARM_AUTHORIZED_MICROUSD?: string;
  SWARM_START_THRESHOLD_MICROUSD?: string;
};

export function requireDatabase(): D1Database {
  if (!env.DB) throw new Error("DATABASE_UNAVAILABLE");
  return env.DB;
}

export function liveExecutionEnabled(): boolean {
  return env.SWARM_LIVE_ENABLED === "true";
}

export function configuredModel(): string {
  return env.SWARM_MODEL || "gpt-6-luna";
}

export function configuredExperimentBudget(): ExperimentBudgetConfig {
  return parseExperimentBudgetConfig(env);
}

export function parseExperimentBudgetConfig(
  source: BudgetEnvironment,
): ExperimentBudgetConfig {
  const authorizedRaw = source.SWARM_AUTHORIZED_MICROUSD;
  const thresholdRaw = source.SWARM_START_THRESHOLD_MICROUSD;
  const authorizedMissing = authorizedRaw === undefined || authorizedRaw === "";
  const thresholdMissing = thresholdRaw === undefined || thresholdRaw === "";
  if (authorizedMissing && thresholdMissing) {
    return { authorizedMicrousd: 0, startThresholdMicrousd: 0 };
  }
  if (authorizedMissing || thresholdMissing) {
    throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_INVALID");
  }
  const config = {
    authorizedMicrousd: parseMicrousd(authorizedRaw),
    startThresholdMicrousd: parseMicrousd(thresholdRaw),
  };
  validateExperimentBudgetConfig(config);
  return config;
}

export function validateExperimentBudgetConfig(
  config: ExperimentBudgetConfig,
): void {
  if (
    !Number.isSafeInteger(config.authorizedMicrousd) ||
    !Number.isSafeInteger(config.startThresholdMicrousd) ||
    config.authorizedMicrousd < 0 ||
    config.startThresholdMicrousd < 0 ||
    config.authorizedMicrousd > MAX_AUTHORIZED_EXPERIMENT_MICROUSD ||
    config.startThresholdMicrousd > config.authorizedMicrousd ||
    (config.authorizedMicrousd === 0) !== (config.startThresholdMicrousd === 0)
  ) {
    throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_INVALID");
  }
}

export function openAIKeyConfigured(): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

export function requireOpenAIKey(): string {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_CREDENTIAL_UNAVAILABLE");
  return env.OPENAI_API_KEY;
}

function parseMicrousd(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_INVALID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("EXPERIMENT_BUDGET_CONFIGURATION_INVALID");
  }
  return parsed;
}
