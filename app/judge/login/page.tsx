import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { JudgeLoginForm } from "@/components/judge/JudgeLoginForm";
import { PageFrame } from "@/components/outing/Shell";
import { LinkButton } from "@/components/ui/Button";
import { isJudgeSession, judgeGateEnabled, safeNextPath } from "@/lib/auth/judge";

export const metadata: Metadata = { title: "Judge sign-in" };
export const dynamic = "force-dynamic";

export default async function JudgeLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Only a same-site relative path survives; anything else becomes the default (/new).
  const next = safeNextPath((await searchParams).next);
  const gateEnabled = judgeGateEnabled();
  if (gateEnabled && (await isJudgeSession())) redirect(next);

  return (
    <PageFrame back={{ href: "/", label: "Back to home" }}>
      <h1 className="font-display text-[34px] leading-[40px] font-semibold tracking-tight">Judge sign-in</h1>
      <p className="mt-3 text-body text-ink-muted">
        Judges sign in to create real outings with PayPal sandbox and Claude. The demo on /demo needs no sign-in.
      </p>
      {gateEnabled ? (
        <JudgeLoginForm next={next} />
      ) : (
        <div className="mt-6 space-y-4">
          <p className="text-body">Judge sign-in is not switched on for this deployment, so nothing here needs it.</p>
          <LinkButton href={next} arrow>
            Continue
          </LinkButton>
        </div>
      )}
      <p className="mt-6 text-small text-ink-muted">
        The username and password are in the testing instructions of the Devpost submission.{" "}
        <Link href="/demo" className="font-semibold text-coral-700 underline underline-offset-4 hover:text-coral-800">
          Open the demo instead
        </Link>
      </p>
    </PageFrame>
  );
}
