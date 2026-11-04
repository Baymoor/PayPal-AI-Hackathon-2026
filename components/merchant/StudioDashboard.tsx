"use client";

/**
 * The real AG Studio instance (heavy: loaded only via next/dynamic ssr:false from DashboardClient).
 * Widgets: bookings-by-status chart, money-by-stage chart (cross-filtered), custom Booking
 * Readiness widget, and the AG Grid booking table.
 */
import { useEffect, useMemo, useRef } from "react";
import { enableStudioDevValidations, type AgDataSourcesDefinition, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";
import type { AgReportState } from "ag-studio";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import type { DashboardQuery } from "@/lib/ai/types";
import { buildStudioData, f } from "./studioData";
import { outingsStudioTheme } from "./studioTheme";
import { outingsWidgets, type OutingsRegistry } from "./ReadinessWidget";
import { createAiSetup } from "./studioAi";

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

function buildReport(sort: DashboardQuery["sort"], currency: string): AgReportState<OutingsRegistry> {
  const col = sort ? SORT_COLUMN[sort.field] : undefined;
  return {
    selectedPageId: "overview",
    pages: [
      {
        id: "overview",
        widgets: {
          "status-chart": {
            type: "column-chart-grouped",
            dataMapping: { categoryKey: [{ id: f("status") }], valueKey: [{ id: f("title"), aggregation: "count" }] },
            format: { title: { enabled: true, text: "Bookings by status" }, crossFilter: "filter", style: { theme: { common: { legend: { enabled: false } } } } },
          },
          "money-chart": {
            type: "column-chart-grouped",
            dataMapping: {
              categoryKey: [{ id: f("status") }],
              valueKey: [sum(f("authorized")), sum(f("captured")), sum(f("refunded"))],
            },
            format: { title: { enabled: true, text: `Money by stage (${currency})`, wrapping: true }, crossFilter: "filter", style: { theme: { common: { legend: { enabled: true, position: "bottom" } } } } },
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
            format: { title: { enabled: true, text: "Booking readiness (open outings)" }, crossFilter: "filter" },
          },
          bookings: {
            type: "grid",
            dataMapping: {
              cols: [
                { id: f("title") },
                { id: f("mode") },
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
            format: { title: { enabled: true, text: "Bookings" }, crossFilter: "filter", style: { grandTotalRow: { enabled: false }, columnAutoSize: true, headerRow: { wrapText: true } } },
          },
        },
        widgetLayout: {
          "status-chart": at(0, 0, 6, 20),
          "money-chart": at(6, 0, 10, 20),
          readiness: at(16, 0, 8, 20),
          bookings: at(0, 20, 24, 24),
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
  licenseKey?: string;
  aiEnabled: boolean;
  onOpenOuting: (id: string) => void;
  onApi?: (api: AgStudioApi) => void;
  onError?: (message: string) => void;
}

export default function StudioDashboard({ rows, currency, sort, focus, licenseKey, aiEnabled, onOpenOuting, onApi, onError }: StudioDashboardProps) {
  const apiRef = useRef<AgStudioApi | null>(null);
  // Source definitions do not depend on the widget registry; the cast only reconciles generics.
  const data = useMemo(() => buildStudioData(rows, currency) as unknown as AgDataSourcesDefinition<OutingsRegistry>, [rows, currency]);
  const initial = useMemo(() => buildReport(sort, currency), [sort, currency]);
  const context = useMemo(() => ({ openOuting: onOpenOuting }), [onOpenOuting]);
  const ai = useMemo(() => (aiEnabled ? createAiSetup() : undefined), [aiEnabled]);

  const wrapRef = useRef<HTMLDivElement>(null);

  // DashboardQuery.focus: ring the matching widget. Studio does not expose widget ids in the DOM,
  // so we rely on layout creation order (status, money, readiness, bookings).
  useEffect(() => {
    if (!focus) return;
    const idx = { STATUS_CHART: 0, MONEY_CHART: 1, READINESS: 2, BOOKINGS_TABLE: 3 }[focus];
    const t = setTimeout(() => {
      const el = wrapRef.current?.querySelectorAll<HTMLElement>(".ag-studio-layout-widget")[idx];
      if (!el) return;
      el.style.outline = "3px solid #C8402D";
      el.style.outlineOffset = "2px";
      el.style.borderRadius = "16px";
    }, 900);
    return () => clearTimeout(t);
  }, [focus]);

  return (
    <div ref={wrapRef} style={{ height: "100%", width: "100%" }}>
    <AgStudioProvider licenseKey={licenseKey}>
      <AgStudio<OutingsRegistry>
        style={{ height: "100%", width: "100%" }}
        data={data}
        initialState={initial}
        theme={outingsStudioTheme}
        widgets={outingsWidgets}
        context={context}
        mode="view"
        panels={{ view: { left: [], right: [] } }}
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
