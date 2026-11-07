import type { Metadata } from "next";
import { OutingClient } from "@/components/outing/OutingClient";

export const metadata: Metadata = { title: "Your outing", robots: { index: false } };

// The view is private, per-participant and live: always rendered at request time, fetched by the client
// (cookie session) and polled while the outing is open.
export const dynamic = "force-dynamic";

const firstParam = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

export default async function OutingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const flag = firstParam(sp.payment);
  // Set by the PayPal return/cancel routes on failure; the client only explains known codes.
  const reason = firstParam(sp.reason);
  return <OutingClient id={id} paymentFlag={flag} paymentReason={reason} />;
}
