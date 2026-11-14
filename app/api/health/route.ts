import { errorResponse, json, requireApiUser } from "@/lib/server/http";
import { experimentStatus } from "@/lib/server/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireApiUser();
    return json({ ok: true, ...(await experimentStatus()) });
  } catch (error) {
    return errorResponse(error);
  }
}
