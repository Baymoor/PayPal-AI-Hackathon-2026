"use client";

import Link from "next/link";
import type { CustomCellRendererProps } from "ag-grid-react";

/**
 * Cell renderer for the Bookings grid "Outing" column: a real link to the merchant drill-down
 * (keyboard focusable, middle-click / open-in-new-tab work). The outing id comes from the row
 * data when Studio exposes it, otherwise from a title lookup supplied by StudioDashboard
 * (only used when the title is unique, so a link never points at the wrong outing).
 */
let idByTitle = new Map<string, string>();

export function setOutingIdLookup(rows: { id: string; title: string }[]): void {
  const m = new Map<string, string | null>();
  for (const r of rows) m.set(r.title, m.has(r.title) ? null : r.id);
  idByTitle = new Map([...m].filter((e): e is [string, string] => e[1] !== null));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idFromRowData(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if ((k === "id" || k.endsWith(".id")) && typeof v === "string" && UUID_RE.test(v)) return v;
  }
  return undefined;
}

export function OutingLinkCell(props: CustomCellRendererProps) {
  const text = props.valueFormatted ?? (props.value == null ? "" : String(props.value));
  const id = idFromRowData(props.data) ?? idByTitle.get(String(props.value ?? ""));
  if (!id || !text) return <>{text}</>;
  return (
    <Link href={`/merchant/outings/${id}`} className="m-grid-link">
      {text}
    </Link>
  );
}
