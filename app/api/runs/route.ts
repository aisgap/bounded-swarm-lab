import { createRunRequestSchema } from "@/lib/server/contracts";
import {
  assertTrustedWrite,
  errorResponse,
  json,
  parseJson,
  requireApiUser,
} from "@/lib/server/http";
import { createLiveRun } from "@/lib/server/service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    assertTrustedWrite(request);
    const user = await requireApiUser();
    const input = await parseJson(request, createRunRequestSchema);
    const result = await createLiveRun(user.userId, input);
    return json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
