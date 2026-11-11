/** GET /api/judge/session -> { gateEnabled, signedIn }: lets the site footer show the judge sign-in state. */
import { hasJudgeSession, judgeGateEnabled } from "@/lib/auth/judge";
import { handle, json } from "@/lib/http";

export const dynamic = "force-dynamic";

export const GET = handle(async (req: Request) => {
  return json({ gateEnabled: judgeGateEnabled(), signedIn: hasJudgeSession(req) });
});
