import "server-only";
import { getChatGPTUser, type ChatGPTUser } from "@/app/chatgpt-auth";
import type { ZodType } from "zod";

const MAX_JSON_BYTES = 64 * 1024;

export class SafeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(
    status: number,
    code: string,
    publicMessage: string,
  ) {
    super(code);
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export async function requireApiUser(): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (!user) throw new SafeHttpError(401, "AUTH_REQUIRED", "Sign in to continue.");
  return user;
}

export function assertTrustedWrite(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new SafeHttpError(415, "JSON_REQUIRED", "Send this request as JSON.");
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new SafeHttpError(403, "CROSS_SITE_WRITE_BLOCKED", "Cross-site writes are not allowed.");
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    throw new SafeHttpError(403, "ORIGIN_REQUIRED", "A same-origin request is required.");
  }
  if (origin !== new URL(request.url).origin) {
    throw new SafeHttpError(403, "ORIGIN_MISMATCH", "The request origin is not allowed.");
  }
}

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const raw = await readRequestBodyLimited(request);

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SafeHttpError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SafeHttpError(400, "INVALID_REQUEST", "The request did not match the required format.");
  }
  return parsed.data;
}

async function readRequestBodyLimited(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_JSON_BYTES) {
    try { await request.body?.cancel(); } catch { /* best effort */ }
    throw new SafeHttpError(413, "REQUEST_TOO_LARGE", "The request is too large.");
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!item.value) continue;
      total += item.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new SafeHttpError(413, "REQUEST_TOO_LARGE", "The request is too large.");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof SafeHttpError) throw error;
    throw new SafeHttpError(400, "REQUEST_READ_FAILED", "The request body could not be read.");
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    throw new SafeHttpError(400, "INVALID_ENCODING", "The request body must use UTF-8.");
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof SafeHttpError) {
    return json({ error: { code: error.code, message: error.publicMessage } }, { status: error.status });
  }
  console.error(JSON.stringify({ event: "request_failed", code: "INTERNAL_ERROR" }));
  return json(
    { error: { code: "INTERNAL_ERROR", message: "The request could not be completed safely." } },
    { status: 500 },
  );
}
