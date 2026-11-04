"use client";

import Link from "next/link";
import type { CustomCellRendererProps } from "ag-grid-react";

/**
 * Cell renderer for the Bookings grid "Outing" column: a real link to the merchant drill-down
 * (keyboard focusable, middle-click / open-in-new-tab work). The outing id comes from the row
 * data when Studio exposes it (the grid maps the "Outing ID" column, so the row always carries it),
 * otherwise from a title lookup supplied by StudioDashboard (only used when the title is unique,
 * so a link never points at the wrong outing). OutingIdLinkCell renders the ID column itself as an
 * "Open" link, which works even when row data keys are not discoverable and titles are duplicated.
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

/** Renderer for the "Outing ID" column: the cell value is the outing id, shown as an "Open" link. */
export function OutingIdLinkCell(props: CustomCellRendererProps) {
  const id = typeof props.value === "string" && UUID_RE.test(props.value) ? props.value : undefined;
  if (!id) return <>{props.value == null ? "" : String(props.value)}</>;
  return (
    <Link href={`/merchant/outings/${id}`} className="m-grid-link" aria-label={`Open outing ${id}`}>
      Open
    </Link>
  );
}
