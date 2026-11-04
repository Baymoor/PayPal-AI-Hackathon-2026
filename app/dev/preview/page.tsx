import { notFound } from "next/navigation";
import { PreviewClient } from "@/components/dev/PreviewClient";

export const dynamic = "force-dynamic";

export default async function PreviewPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  const s = Array.isArray(sp.s) ? sp.s[0] : sp.s;
  return <PreviewClient selected={s ?? null} />;
}
