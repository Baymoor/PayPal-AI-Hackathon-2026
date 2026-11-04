import type { Metadata } from "next";
import { DemoHub } from "@/components/outing/DemoHub";
import { PageFrame } from "@/components/outing/Shell";
import { clampScenarioSeconds } from "@/lib/demo/constants";

export const metadata: Metadata = { title: "Try the demo" };

/**
 * `/demo?deadlineSeconds=70` pre-selects a custom scenario deadline (60-600 s), e.g. for a recording
 * or the end-to-end test. Without it the hub offers 1, 1.5, 2 (default) and 5 minutes.
 */
export default async function DemoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = (await searchParams).deadlineSeconds;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (
    <PageFrame back={{ href: "/", label: "Back to home" }}>
      <DemoHub initialDeadlineSeconds={value ? clampScenarioSeconds(value) : undefined} />
    </PageFrame>
  );
}
