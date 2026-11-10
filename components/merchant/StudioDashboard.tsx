"use client";

/**
 * The real AG Studio instance (heavy: loaded only via next/dynamic ssr:false from DashboardClient).
 * Page "Bookings": KPI value widgets, status + money charts, custom Booking Readiness widget, booking grid.
 * Page "Money": KPI value widgets, custom Money flow widget, captured-vs-refunded and holds charts.
 * Everything on a page cross-filters; the KPIs are Studio widgets so they follow the filters.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { enableStudioDevValidations, type AgDataSourcesDefinition, type AgStudioApi } from "ag-studio";
import { AgStudioAiModule } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import type { AgReportState } from "ag-studio";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import type { DashboardQuery } from "@/lib/ai/types";
import { buildStudioData, f } from "./studioData";
import { outingsStudioTheme } from "./studioTheme";
import { outingsWidgets, type OutingsRegistry } from "./outingsWidgets";
import { createAiSetup } from "./studioAi";
import { setOutingIdLookup } from "./OutingLinkCell";

if (process.env.NODE_ENV !== "production") enableStudioDevValidations();

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number) => ({ xTrack, yTrack, xSpan, ySpan });
const sum = (id: string) => ({ id, aggregation: "sum" as const });

/** Which Studio column a DashboardQuery sort maps to (only for fields the grid shows). */
const SORT_COLUMN: Partial<Record<NonNullable<DashboardQuery["sort"]>["field"], string>> = {
  status: f("status"),
  closesWithinHours: f("closingAt"),
  closesToday: f("closingAt"),
  missingRequired: f("missingRequired"),
  requiredAccepted: f("requiredAccepted"),
  requiredInvited: f("requiredInvited"),
  payersAuthorized: f("payersAuthorized"),
  minPayers: f("minPayers"),
  authorizedTotalMinor: f("authorized"),
  capturedTotalMinor: f("captured"),
  refundedTotalMinor: f("refunded"),
  cleanup: f("recovery"),
};

export type StudioPage = "bookings" | "money";

/**
 * Style of a chart that counts outings. Studio cannot set an axis step, so a small count got ticks at 0.5 and
 * 1.5. The count is written on each bar instead, and the value axis keeps only its baseline.
 */
const COUNT_BARS = {
  theme: {
    common: { legend: { enabled: false } },
    bar: { series: { label: { enabled: true, color: "#FFFFFF", fontWeight: "bold" as const, fontSize: 14 } } },
  },
  custom: { valueAxis: { label: { color: "transparent" }, gridLine: { enabled: false }, tick: { enabled: false } } },
};

const kpi = (
  field: { id: string; aggregation: "sum" },
  title: string,
  subtitle: string,
): { type: "value"; dataMapping: { value: [typeof field] }; format: { title: { enabled: true; text: string }; subtitle: { enabled: true; text: string }; crossFilter: "filter" } } => ({
  type: "value",
  dataMapping: { value: [field] },
  format: { title: { enabled: true, text: title }, subtitle: { enabled: true, text: subtitle }, crossFilter: "filter" },
});

function buildReport(sort: DashboardQuery["sort"], currency: string, page: StudioPage): AgReportState<OutingsRegistry> {
  const col = sort ? SORT_COLUMN[sort.field] : undefined;
  const legendBottom = { theme: { common: { legend: { enabled: true, position: "bottom" as const } } } };
  return {
    selectedPageId: page,
    pages: [
      {
        id: "bookings",
        widgets: {
          "kpi-open": kpi(sum(f("isOpen")), "Open outings", "Collecting commitments now"),
          "kpi-closing": kpi(sum(f("closesTodayOpen")), "Closing today", "Open outings with a deadline today"),
          "kpi-captured": kpi(sum(f("capturedConfirmed")), "Captured", "From confirmed bookings"),
          "kpi-refunds": kpi(sum(f("refundPending")), "Refunds pending", "Captured payments waiting to be refunded"),
          // Stacked over one 0/1 measure per status family: each status has a single non-zero segment, so its
          // bar takes that family's palette colour (confirmed green, recovering purple, collecting blue, cancelled slate).
          "status-chart": {
            type: "column-chart-stacked",
            dataMapping: {
              categoryKey: [{ id: f("status") }],
              valueKey: [sum(f("countConfirmed")), sum(f("countRecovering")), sum(f("countCollecting")), sum(f("countCancelled"))],
            },
            format: {
              title: { enabled: true, text: "Bookings by status" },
              subtitle: { enabled: true, text: "Click a bar to filter the page" },
              crossFilter: "filter",
              style: COUNT_BARS,
            },
          },
          "money-chart": {
            type: "column-chart-grouped",
            dataMapping: {
              categoryKey: [{ id: f("status") }],
              // Palette order: captured, refunded, authorized.
              valueKey: [sum(f("captured")), sum(f("refunded")), sum(f("authorized"))],
            },
            format: {
              title: { enabled: true, text: `Money by stage (${currency})`, wrapping: true },
              subtitle: { enabled: true, text: "Authorized holds are not revenue" },
              crossFilter: "filter",
              style: legendBottom,
            },
          },
          readiness: {
            type: "booking-readiness",
            dataMapping: {
              outing: [{ id: f("title") }],
              outingId: [{ id: f("id") }],
              status: [{ id: f("status") }],
              mode: [{ id: f("mode") }],
              reqAccepted: [sum(f("requiredAccepted"))],
              reqInvited: [sum(f("requiredInvited"))],
              payers: [sum(f("payersAuthorized"))],
              minPayers: [sum(f("minPayers"))],
              deadline: [{ id: f("closingAt"), aggregation: "min" }],
            },
            format: {
              title: { enabled: true, text: "Booking readiness" },
              subtitle: { enabled: true, text: "Open outings, closest deadline first" },
              crossFilter: "filter",
            },
          },
          bookings: {
            type: "grid",
            dataMapping: {
              cols: [
                { id: f("title") },
                { id: f("modeLabel") },
                { id: f("status") },
                { id: f("closingAt") },
                { id: f("requiredLabel") },
                { id: f("payersLabel") },
                { id: f("authorized") },
                { id: f("allocated") },
                { id: f("captured") },
                { id: f("refunded") },
                { id: f("recovery") },
                { id: f("id") },
              ],
            },
            ...(col ? { sort: [{ field: { id: col }, direction: sort!.direction }] } : {}),
            format: {
              title: { enabled: true, text: "Bookings" },
              subtitle: { enabled: true, text: "One row per outing. Real sandbox rows and fixtures are labelled" },
              crossFilter: "filter",
              style: { grandTotalRow: { enabled: false }, columnAutoSize: true },
            },
          },
        },
        widgetLayout: {
          "kpi-open": at(0, 0, 6, 5),
          "kpi-closing": at(6, 0, 6, 5),
          "kpi-captured": at(12, 0, 6, 5),
          "kpi-refunds": at(18, 0, 6, 5),
          "status-chart": at(0, 5, 7, 19),
          "money-chart": at(7, 5, 9, 19),
          readiness: at(16, 5, 8, 19),
          bookings: at(0, 24, 24, 22),
        },
      },
      {
        id: "money",
        widgets: {
          "m-kpi-captured": kpi(sum(f("capturedConfirmed")), "Captured", "From confirmed bookings"),
          "m-kpi-refunds": kpi(sum(f("refundPending")), "Refunds pending", "Number of refunds in flight"),
          "m-kpi-awaiting": kpi(sum(f("refundDue")), "Awaiting refund", "Captured, not yet refunded"),
          "m-kpi-holds": kpi(sum(f("authorized")), "Holds outstanding", "Authorized, not captured. Not revenue"),
          "money-flow": {
            type: "money-flow",
            dataMapping: {
              outing: [{ id: f("title") }],
              outingId: [{ id: f("id") }],
              status: [{ id: f("status") }],
              mode: [{ id: f("mode") }],
              hold: [sum(f("holdMinor"))],
              captured: [sum(f("capturedMinor"))],
              refunded: [sum(f("refundedMinor"))],
              refundDue: [sum(f("refundDueMinor"))],
              voidPending: [sum(f("voidPending"))],
              refundPending: [sum(f("refundPending"))],
            },
            format: {
              title: { enabled: true, text: "Money flow" },
              subtitle: { enabled: true, text: "Where each authorized dollar went, per outing. Click an outing to filter" },
              crossFilter: "filter",
            },
          },
          "captured-vs-refunded": {
            type: "column-chart-grouped",
            dataMapping: { categoryKey: [{ id: f("status") }], valueKey: [sum(f("captured")), sum(f("refunded"))] },
            format: {
              title: { enabled: true, text: `Captured vs refunded (${currency})`, wrapping: true },
              subtitle: { enabled: true, text: "By outing status. Refunded money was captured first" },
              crossFilter: "filter",
              style: legendBottom,
            },
          },
          // Stacked over the holds of each status family, like the status chart: a status keeps its colour.
          "holds-by-status": {
            type: "bar-chart-stacked",
            dataMapping: {
              categoryKey: [{ id: f("status") }],
              valueKey: [sum(f("holdConfirmed")), sum(f("holdRecovering")), sum(f("holdCollecting")), sum(f("holdCancelled"))],
            },
            format: {
              title: { enabled: true, text: `Holds outstanding (${currency})`, wrapping: true },
              subtitle: { enabled: true, text: "Uncaptured authorizations by outing status" },
              crossFilter: "filter",
              style: { theme: { common: { legend: { enabled: false } } } },
            },
          },
        },
        widgetLayout: {
          "m-kpi-captured": at(0, 0, 6, 5),
          "m-kpi-refunds": at(6, 0, 6, 5),
          "m-kpi-awaiting": at(12, 0, 6, 5),
          "m-kpi-holds": at(18, 0, 6, 5),
          "money-flow": at(0, 5, 15, 41),
          "captured-vs-refunded": at(15, 5, 9, 20),
          "holds-by-status": at(15, 25, 9, 21),
        },
      },
    ],
  };
}

export interface StudioDashboardProps {
  rows: MerchantBookingRow[];
  currency: string;
  sort: DashboardQuery["sort"];
  focus: DashboardQuery["focus"];
  page: StudioPage;
  licenseKey?: string;
  aiEnabled: boolean;
  /** "edit" opens Studio with only the AI assistant panel (see panels below). */
  mode: "view" | "edit";
  onOpenOuting: (id: string) => void;
  onApi?: (api: AgStudioApi) => void;
  onError?: (message: string) => void;
}

export default function StudioDashboard({ rows, currency, sort, focus, page, licenseKey, aiEnabled, mode, onOpenOuting, onApi, onError }: StudioDashboardProps) {
  const apiRef = useRef<AgStudioApi | null>(null);
  // Source definitions do not depend on the widget registry; the cast only reconciles generics.
  useMemo(() => setOutingIdLookup(rows.map((r) => ({ id: r.outingId, title: r.title }))), [rows]);
  const data = useMemo(() => buildStudioData(rows, currency) as unknown as AgDataSourcesDefinition<OutingsRegistry>, [rows, currency]);
  // initialState is read once at creation (remount via key); later page switches go through api.setState.
  const [initialPage] = useState(page);
  const initial = useMemo(() => buildReport(sort, currency, initialPage), [sort, currency, initialPage]);
  const context = useMemo(() => ({ openOuting: onOpenOuting, currency }), [onOpenOuting, currency]);
  const ai = useMemo(() => (aiEnabled ? createAiSetup() : undefined), [aiEnabled]);

  const wrapRef = useRef<HTMLDivElement>(null);

  // Switch Studio page (host-driven navigation: pages have no titles in report state).
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const state = api.getState();
    if (state.selectedPageId !== page) api.setState({ ...state, selectedPageId: page });
  }, [page]);

  // DashboardQuery.focus: ring the matching widget (bookings page). Studio does not expose widget ids
  // in the DOM, so match on the widget title text.
  useEffect(() => {
    if (!focus || page !== "bookings") return;
    const title = { STATUS_CHART: "Bookings by status", MONEY_CHART: "Money by stage", READINESS: "Booking readiness", BOOKINGS_TABLE: "One row per outing" }[focus];
    const t = setTimeout(() => {
      const els = [...(wrapRef.current?.querySelectorAll<HTMLElement>(".ag-studio-layout-widget") ?? [])];
      const el = els.find((e) => (e.textContent ?? "").includes(title));
      if (!el) return;
      el.style.outline = "3px solid #C8402D";
      el.style.outlineOffset = "2px";
      el.style.borderRadius = "16px";
    }, 900);
    return () => clearTimeout(t);
  }, [focus, page]);

  return (
    <div ref={wrapRef} style={{ height: "100%", width: "100%" }}>
    <AgStudioProvider licenseKey={licenseKey} modules={aiEnabled ? [AgStudioAiModule] : undefined}>
      <AgStudio<OutingsRegistry>
        style={{ height: "100%", width: "100%" }}
        data={data}
        initialState={initial}
        theme={outingsStudioTheme}
        widgets={outingsWidgets}
        context={context}
        mode={mode}
        panels={{ view: { left: [], right: [] }, edit: { left: [], right: aiEnabled ? ["ai"] : [] } }}
        ai={ai}
        onApiReady={(e) => {
          apiRef.current = e.api;
          onApi?.(e.api);
        }}
        onErrorRaised={(e) => onError?.(String((e as { message?: unknown }).message ?? "AG Studio reported an error"))}
      />
    </AgStudioProvider>
    </div>
  );
}
