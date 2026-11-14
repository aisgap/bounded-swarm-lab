import { z } from "zod";

const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Use a non-confidential request identifier.");

export const createRunRequestSchema = z
  .object({
    idempotencyKey,
    objective: z.string().trim().min(1).max(700),
    acceptanceCriteria: z.string().trim().min(1).max(700),
  })
  .strict();

export const stepRunRequestSchema = z.object({ idempotencyKey }).strict();

export const stopRunRequestSchema = z
  .object({ idempotencyKey })
  .strict();

export const runIdSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;
export type StepRunRequest = z.infer<typeof stepRunRequestSchema>;
export type StopRunRequest = z.infer<typeof stopRunRequestSchema>;
