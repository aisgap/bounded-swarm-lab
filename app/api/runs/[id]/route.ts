import { runIdSchema } from "@/lib/server/contracts";
import { errorResponse, json, requireApiUser, SafeHttpError } from "@/lib/server/http";
import { getLiveRun } from "@/lib/server/service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiUser();
    const parsed = runIdSchema.safeParse((await context.params).id);
    if (!parsed.success) throw new SafeHttpError(400, "INVALID_RUN_ID", "The run identifier is invalid.");
    return json({ run: await getLiveRun(user.userId, parsed.data) });
  } catch (error) {
    return errorResponse(error);
  }
}
