import type { Metadata } from "next";
import { OutingClient } from "@/components/outing/OutingClient";

export const metadata: Metadata = { title: "Your outing", robots: { index: false } };

// The view is private, per-participant and live: always rendered at request time, fetched by the client
// (cookie session) and polled while the outing is open.
export const dynamic = "force-dynamic";

export default async function OutingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const flag = Array.isArray(sp.payment) ? sp.payment[0] : sp.payment;
  return <OutingClient id={id} paymentFlag={flag} />;
}
