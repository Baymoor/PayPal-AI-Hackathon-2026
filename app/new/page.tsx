import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NewOutingForm } from "@/components/outing/NewOutingForm";
import { PageFrame } from "@/components/outing/Shell";
import { isJudgeSession, judgeLoginHref } from "@/lib/auth/judge";

export const metadata: Metadata = { title: "Create an outing" };

export const dynamic = "force-dynamic";

export default async function NewPage() {
  // Creating an outing uses real PayPal sandbox and Claude on the hosted demo: judges only (no-op when the gate is off).
  if (!(await isJudgeSession())) redirect(judgeLoginHref("/new"));
  return (
    <PageFrame wide back={{ href: "/", label: "Back to home" }}>
      <NewOutingForm />
    </PageFrame>
  );
}
