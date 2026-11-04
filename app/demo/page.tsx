import type { Metadata } from "next";
import { DemoHub } from "@/components/outing/DemoHub";
import { PageFrame } from "@/components/outing/Shell";

export const metadata: Metadata = { title: "Try the demo" };

export default function DemoPage() {
  return (
    <PageFrame back={{ href: "/", label: "Back to home" }}>
      <DemoHub />
    </PageFrame>
  );
}
