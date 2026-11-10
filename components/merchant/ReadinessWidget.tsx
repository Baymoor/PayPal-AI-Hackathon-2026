"use client";

/**
 * "Booking Readiness": a custom AG Studio widget (registered through createWidgets).
 * It queries Studio's data engine via widgetApi.getData (so page filters and cross
 * filters from the other widgets apply) and renders one card per OPEN outing.
 */
import { useEffect, useMemo, useState } from "react";
import type { AgWidgetData, AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetParams } from "ag-studio";
import type { AgWidgetDefinition } from "ag-studio-react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { VERDICT_LABEL, READINESS_RULE_TEXT, assessReadiness, type Verdict } from "./readiness";
import { formatCountdown } from "./format";

interface ReadinessWidgetState
  extends AgWidgetData<
    {
      outing: AgWidgetFieldReference[];
      outingId: AgWidgetFieldReference[];
      status: AgWidgetFieldReference[];
      mode: AgWidgetFieldReference[];
      reqAccepted: AgWidgetFieldReference[];
      reqInvited: AgWidgetFieldReference[];
      payers: AgWidgetFieldReference[];
      minPayers: AgWidgetFieldReference[];
      deadline: AgWidgetFieldReference[];
    },
    AgWidgetDataFormat<Record<string, never>>
  > {
  type: "booking-readiness";
}

export interface DashboardContext {
  openOuting?: (outingId: string) => void;
  /** ISO currency of every row Studio holds (single currency per dashboard). */
  currency?: string;
}

const ICON: Record<Verdict, typeof CheckCircle2> = { READY: CheckCircle2, AT_RISK: AlertTriangle, WILL_CANCEL: XCircle };

/** "closes in 1h 52m", or "closed 5m ago" once the deadline has passed. */
function deadlineText(minutesLeft: number | null): string {
  if (minutesLeft === null) return "No deadline";
  return `${minutesLeft < 0 ? "closed" : "closes"} ${formatCountdown(minutesLeft)}`;
}

function BookingReadiness(p: AgWidgetParams<ReadinessWidgetState>) {
  const m = p.dataMapping;
  const slots = ["outing", "outingId", "status", "mode", "reqAccepted", "reqInvited", "payers", "minPayers", "deadline"] as const;
  const fields = slots.flatMap((k) => m[k] ?? []);
  const sig = fields.map((f) => f.key).join("|");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const ctx = (p.context ?? {}) as DashboardContext;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (slots.some((k) => !m[k]?.length)) {
      p.widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const ac = new AbortController();
    p.widgetApi
      .getData({ fields }, { signal: ac.signal })
      .then((r) => {
        setRows(r.results.rows);
        p.widgetApi.setDisplayState(r.results.rows.length ? "displayed" : "noData");
      })
      .catch(() => {
        /* aborted by a newer query, or reported via onErrorRaised */
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, p]);

  const items = useMemo(() => {
    const get = (r: Record<string, unknown>, k: (typeof slots)[number]) => {
      const f = m[k]?.[0];
      return f ? r[f.key] : undefined;
    };
    return rows
      .filter((r) => String(get(r, "status")) === "Collecting")
      .map((r) => {
        const deadline = get(r, "deadline");
        const t = deadline ? new Date(String(deadline)).getTime() : NaN;
        const minutesLeft = Number.isNaN(t) ? null : (t - now) / 60000;
        const accepted = Number(get(r, "reqAccepted") ?? 0);
        const invited = Number(get(r, "reqInvited") ?? 0);
        const payers = Number(get(r, "payers") ?? 0);
        const min = Number(get(r, "minPayers") ?? 0);
        const a = assessReadiness({ requiredAccepted: accepted, requiredInvited: invited, payersAuthorized: payers, minPayers: min, minutesLeft });
        return { id: String(get(r, "outingId")), title: String(get(r, "outing")), mode: String(get(r, "mode")), accepted, invited, payers, min, minutesLeft, a, field: m.outingId![0] };
      })
      .sort((x, y) => (x.minutesLeft ?? 1e12) - (y.minutesLeft ?? 1e12));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, now, sig]);

  return (
    <div className="mw-root">
      {items.length === 0 ? (
        <p className="mw-empty">No open outings match the current filters. Outings that are not collecting are excluded.</p>
      ) : (
        <ul className="mw-list">
          {items.map((it) => {
            const Icon = ICON[it.a.verdict];
            return (
              <li key={it.id} className="mw-item">
                {/* One status chip per card; the numbers sit on one line so two or three outings fit without scrolling. */}
                <div className="mw-head">
                  <button
                    type="button"
                    className="mw-title"
                    title={`${it.title}: cross-filter the other widgets to this outing`}
                    onClick={() => p.widgetApi.toggleCrossFilter({ type: "value", group: 0, field: it.field, value: it.id })}
                  >
                    {it.title}
                  </button>
                  <span className="mw-verdict" data-tone={it.a.verdict}>
                    <Icon size={13} aria-hidden /> {VERDICT_LABEL[it.a.verdict]}
                  </span>
                </div>
                <p className="mw-facts">
                  {/* Fixture rows stay labelled, as plain text rather than a second badge. */}
                  {it.mode === "Fixture" && <span className="mw-fixture">Fixture</span>}
                  <span>{it.accepted}/{it.invited} accepted</span>
                  <span>{it.payers}/{it.min} holds</span>
                  <span>{deadlineText(it.minutesLeft)}</span>
                </p>
                <p className="mw-reason">
                  {it.a.reasons.join(". ")}.{" "}
                  <a
                    className="mw-link"
                    href={`/merchant/outings/${it.id}`}
                    onClick={(e) => {
                      if (ctx.openOuting) {
                        e.preventDefault();
                        ctx.openOuting(it.id);
                      }
                    }}
                  >
                    View details
                  </a>
                </p>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mw-rule">{READINESS_RULE_TEXT}</p>
    </div>
  );
}

export const readinessDef = {
  id: "booking-readiness",
  label: "Booking readiness",
  comp: BookingReadiness,
  dataMapping: {
    outing: { type: "field", supportedRoles: ["category"], required: true },
    outingId: { type: "field", supportedRoles: ["category"], required: true },
    status: { type: "field", supportedRoles: ["category"], required: true },
    mode: { type: "field", supportedRoles: ["category"], required: true },
    reqAccepted: { type: "field", supportedRoles: ["numeric"], required: true },
    reqInvited: { type: "field", supportedRoles: ["numeric"], required: true },
    payers: { type: "field", supportedRoles: ["numeric"], required: true },
    minPayers: { type: "field", supportedRoles: ["numeric"], required: true },
    deadline: { type: "field", supportedRoles: ["temporal"], required: true },
  },
  form: ({ createDefaults }) =>
    createDefaults({
      dataMappingItems: [
        { key: "outing", label: "Outing" },
        { key: "outingId", label: "Outing ID" },
        { key: "status", label: "Status" },
        { key: "mode", label: "Mode" },
        { key: "reqAccepted", label: "Required accepted" },
        { key: "reqInvited", label: "Required invited" },
        { key: "payers", label: "Payers authorized" },
        { key: "minPayers", label: "Min payers" },
        { key: "deadline", label: "Deadline" },
      ],
    }),
  defaultSize: { width: 10, height: 16 },
  minSize: { width: 8, height: 10 },
} satisfies AgWidgetDefinition<"booking-readiness", ReadinessWidgetState>;
