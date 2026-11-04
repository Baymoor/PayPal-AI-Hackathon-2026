import type { Metadata } from "next";
import { NewOutingForm } from "@/components/outing/NewOutingForm";
import { PageFrame } from "@/components/outing/Shell";

export const metadata: Metadata = { title: "Create an outing" };

export default function NewPage() {
  return (
    <PageFrame wide back={{ href: "/", label: "Back to home" }}>
      <NewOutingForm />
    </PageFrame>
  );
}
