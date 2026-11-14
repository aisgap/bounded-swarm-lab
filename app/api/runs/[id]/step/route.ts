import { runIdSchema, stepRunRequestSchema } from "@/lib/server/contracts";
import {
  assertTrustedWrite,
  errorResponse,
  json,
  parseJson,
  requireApiUser,
  SafeHttpError,
} from "@/lib/server/http";
import { stepLiveRun } from "@/lib/server/service";

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
    const input = await parseJson(request, stepRunRequestSchema);
    return json(await stepLiveRun(user.userId, runId.data, input));
  } catch (error) {
    return errorResponse(error);
  }
}
