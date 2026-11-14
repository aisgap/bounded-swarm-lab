import { requireChatGPTUser } from "./chatgpt-auth";
import { SwarmLab } from "./swarm-lab";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  const safeDisplayName = user.fullName?.trim() || "Signed-in user";

  return <SwarmLab displayName={safeDisplayName} />;
}
