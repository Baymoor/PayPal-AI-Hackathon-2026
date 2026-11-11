"use client";

/**
 * "Money flow": a custom AG Studio widget (registered through createWidgets).
 * One horizontal stacked bar per outing, plus an aggregate bar for whatever the current
 * filters/cross-filters leave in view. All amounts are integer minor units summed by Studio's
 * data engine (the *Minor fields) and formatted with formatMoney; no floating point sums.
 * Clicking an outing toggles a Studio cross-filter on it (same mechanism as Booking readiness).
 */
import { useEffect, useMemo, useState } from "react";
import type { AgWidgetData, AgWidgetDataFormat, AgWidgetFieldReference, AgWidgetParams } from "ag-studio";
import type { AgWidgetDefinition } from "ag-studio-react";
import { FIXTURE_ROW_LABEL } from "@/lib/domain/labels";
import { formatMoney } from "./format";
import { MONEY_FLOW_FORMULA, flowSegments, type FlowSegments } from "./moneyFlow";
import type { DashboardContext } from "./ReadinessWidget";

interface MoneyFlowState
  extends AgWidgetData<
    {
      outing: AgWidgetFieldReference[];
      outingId: AgWidgetFieldReference[];
      status: AgWidgetFieldReference[];
      mode: AgWidgetFieldReference[];
      hold: AgWidgetFieldReference[];
      captured: AgWidgetFieldReference[];
      refunded: AgWidgetFieldReference[];
      refundDue: AgWidgetFieldReference[];
      voidPending: AgWidgetFieldReference[];
      refundPending: AgWidgetFieldReference[];
    },
    AgWidgetDataFormat<Record<string, never>>
  > {
  type: "money-flow";
}

const SLOTS = ["outing", "outingId", "status", "mode", "hold", "captured", "refunded", "refundDue", "voidPending", "refundPending"] as const;
type Slot = (typeof SLOTS)[number];

interface Item {
  id: string;
  title: string;
  status: string;
  mode: string;
  seg: FlowSegments;
  voidPending: number;
  refundPending: number;
}

type SegKey = "keptMinor" | "refundDueMinor" | "refundedMinor" | "holdMinor";
const SEGMENTS: { key: SegKey; label: string; short: string; tone: string }[] = [
  { key: "keptMinor", label: "Captured (kept)", short: "Captured", tone: "captured" },
  { key: "refundDueMinor", label: "Refund pending", short: "Refund pending", tone: "pending" },
  { key: "refundedMinor", label: "Refunded", short: "Refunded", tone: "refunded" },
  { key: "holdMinor", label: "Still on hold", short: "On hold", tone: "authorized" },
];

function describe(seg: FlowSegments, currency: string): string {
  if (seg.totalMinor === 0) return "No money has moved yet.";
  return SEGMENTS.map((s) => `${s.label} ${formatMoney(seg[s.key], currency)}`).join(", ") + `. Total ${formatMoney(seg.totalMinor, currency)}.`;
}

function FlowBar({ seg, currency, name }: { seg: FlowSegments; currency: string; name: string }) {
  if (seg.totalMinor === 0) {
    return <div className="mf-bar mf-bar-empty" role="img" aria-label={`${name}: no money has moved yet`}>No money moved yet</div>;
  }
  return (
    <div className="mf-bar" role="img" aria-label={`${name}: ${describe(seg, currency)}`}>
      {SEGMENTS.filter((s) => seg[s.key] > 0).map((s) => (
        <div key={s.key} className="mf-seg" data-tone={s.tone} style={{ flexGrow: seg[s.key], flexBasis: 0 }} title={`${s.label}: ${formatMoney(seg[s.key], currency)}`}>
          {seg[s.key] / seg.totalMinor > 0.16 ? formatMoney(seg[s.key], currency) : ""}
        </div>
      ))}
    </div>
  );
}

function Figures({ seg, currency }: { seg: FlowSegments; currency: string }) {
  return (
    <dl className="mf-figs">
      {SEGMENTS.map((s) => (
        <div key={s.key} data-zero={seg[s.key] === 0}>
          <dt><i className="mf-dot" data-tone={s.tone} aria-hidden /> {s.short}</dt>
          <dd>{formatMoney(seg[s.key], currency)}</dd>
        </div>
      ))}
    </dl>
  );
}

function MoneyFlow(p: AgWidgetParams<MoneyFlowState>) {
  const m = p.dataMapping;
  const ctx = (p.context ?? {}) as DashboardContext;
  const currency = ctx.currency ?? "USD";
  const fields = SLOTS.flatMap((k) => m[k] ?? []);
  const sig = fields.map((f) => f.key).join("|");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (SLOTS.some((k) => !m[k]?.length)) {
      p.widgetApi.setDisplayState("incompleteDataMapping");
      return;
    }
    const ac = new AbortController();
    p.widgetApi
      .getData({ fields }, { signal: ac.signal })
      .then((r) => {
        setRows(r.results.rows);
        setLoaded(true);
        p.widgetApi.setDisplayState("displayed");
      })
      .catch(() => {
        /* aborted by a newer query, or reported via onErrorRaised */
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, p]);

  const { items, total } = useMemo(() => {
    const get = (r: Record<string, unknown>, k: Slot) => {
      const f = m[k]?.[0];
      return f ? r[f.key] : undefined;
    };
    const num = (r: Record<string, unknown>, k: Slot) => Math.round(Number(get(r, k) ?? 0));
    const list: Item[] = rows.map((r) => ({
      id: String(get(r, "outingId")),
      title: String(get(r, "outing")),
      status: String(get(r, "status")),
      mode: String(get(r, "mode")),
      seg: flowSegments({ authorizedMinor: num(r, "hold"), capturedMinor: num(r, "captured"), refundedMinor: num(r, "refunded"), refundDueMinor: num(r, "refundDue") }),
      voidPending: num(r, "voidPending"),
      refundPending: num(r, "refundPending"),
    }));
    list.sort((a, b) => b.seg.totalMinor - a.seg.totalMinor || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    const sum = (k: SegKey) => list.reduce((acc, i) => acc + i.seg[k], 0);
    const agg = flowSegments({ authorizedMinor: sum("holdMinor"), capturedMinor: sum("keptMinor") + sum("refundDueMinor") + sum("refundedMinor"), refundedMinor: sum("refundedMinor"), refundDueMinor: sum("refundDueMinor") });
    return { items: list, total: agg };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sig]);

  const selected = new Set<string>(
    (p.widgetApi.getCrossFilterSelections() ?? []).flatMap((s) => (s.type === "value" ? s.values.map(String) : [])),
  );
  const pendingReleases = items.reduce((a, i) => a + i.voidPending, 0);

  return (
    <div className="mf-root">
      {loaded && items.length === 0 ? (
        <p className="mf-empty">No outings match the current filters, so there is no money to show. Clear a filter or pick another data source.</p>
      ) : (
        <>
          <section className="mf-total" aria-label="All outings in view">
            <div className="mf-head">
              <strong>All outings in view ({items.length})</strong>
              <span className="mf-sum">{formatMoney(total.totalMinor, currency)} authorized or captured</span>
            </div>
            <FlowBar seg={total} currency={currency} name="All outings in view" />
            <Figures seg={total} currency={currency} />
            {pendingReleases > 0 && (
              <p className="mf-note">{pendingReleases} hold release{pendingReleases === 1 ? "" : "s"} still pending (amount not in the booking data, not drawn).</p>
            )}
          </section>
          <ul className="mf-list">
            {items.map((it) => (
              <li key={it.id} className="mf-item" data-selected={selected.has(it.id)}>
                <div className="mf-head">
                  <button
                    type="button"
                    className="mf-title"
                    aria-pressed={selected.has(it.id)}
                    title="Cross-filter the other widgets to this outing"
                    onClick={() => p.widgetApi.toggleCrossFilter({ type: "value", group: 0, field: m.outingId![0], value: it.id })}
                  >
                    {it.title}
                  </button>
                  {it.mode === FIXTURE_ROW_LABEL && <span className="m-badge" data-tone="fixture">{FIXTURE_ROW_LABEL}</span>}
                  <span className="m-badge">{it.status}</span>
                  <span className="mf-sum">{formatMoney(it.seg.totalMinor, currency)}</span>
                </div>
                <FlowBar seg={it.seg} currency={currency} name={it.title} />
                <Figures seg={it.seg} currency={currency} />
                {(it.voidPending > 0 || it.refundPending > 0) && (
                  <p className="mf-note">
                    {it.voidPending > 0 && `${it.voidPending} hold release${it.voidPending === 1 ? "" : "s"} pending. `}
                    {it.refundPending > 0 && `${it.refundPending} refund${it.refundPending === 1 ? "" : "s"} pending.`}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mf-rule"><strong>A hold is not a charge.</strong> Authorized holds reserve money on a card and are not revenue until captured. {MONEY_FLOW_FORMULA}</p>
    </div>
  );
}

export const moneyFlowDef = {
  id: "money-flow",
  label: "Money flow",
  comp: MoneyFlow,
  dataMapping: {
    outing: { type: "field", supportedRoles: ["category"], required: true },
    outingId: { type: "field", supportedRoles: ["category"], required: true },
    status: { type: "field", supportedRoles: ["category"], required: true },
    mode: { type: "field", supportedRoles: ["category"], required: true },
    hold: { type: "field", supportedRoles: ["numeric"], required: true },
    captured: { type: "field", supportedRoles: ["numeric"], required: true },
    refunded: { type: "field", supportedRoles: ["numeric"], required: true },
    refundDue: { type: "field", supportedRoles: ["numeric"], required: true },
    voidPending: { type: "field", supportedRoles: ["numeric"], required: true },
    refundPending: { type: "field", supportedRoles: ["numeric"], required: true },
  },
  form: ({ createDefaults }) =>
    createDefaults({
      dataMappingItems: [
        { key: "outing", label: "Outing" },
        { key: "outingId", label: "Outing ID (unique key)" },
        { key: "status", label: "Status" },
        { key: "mode", label: "Mode" },
        { key: "hold", label: "Still on hold (minor units)" },
        { key: "captured", label: "Captured (minor units)" },
        { key: "refunded", label: "Refunded (minor units)" },
        { key: "refundDue", label: "Refund pending (minor units)" },
        { key: "voidPending", label: "Hold releases pending" },
        { key: "refundPending", label: "Refunds pending" },
      ],
    }),
  defaultSize: { width: 14, height: 24 },
  minSize: { width: 8, height: 12 },
} satisfies AgWidgetDefinition<"money-flow", MoneyFlowState>;
