import { runIdSchema, stopRunRequestSchema } from "@/lib/server/contracts";
import {
  assertTrustedWrite,
  errorResponse,
  json,
  parseJson,
  requireApiUser,
  SafeHttpError,
} from "@/lib/server/http";
import { stopLiveRun } from "@/lib/server/service";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    assertTrustedWrite(request);
    const user = await requireApiUser();
    const runId = runIdSchema.safeParse((await context.params).id);
    if (!runId.success) throw new SafeHttpError(400, "INVALID_RUN_ID", "The run identifier is invalid.");
    await parseJson(request, stopRunRequestSchema);
    return json({ run: await stopLiveRun(user.userId, runId.data) });
  } catch (error) {
    return errorResponse(error);
  }
}
