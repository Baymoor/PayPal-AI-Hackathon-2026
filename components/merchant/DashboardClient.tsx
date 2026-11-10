"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Bot, Info, RefreshCw } from "lucide-react";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import type { FriendlyError } from "@/components/errors/friendlyError";
import { ApiError, fetchBookings } from "./api";
import { describeMerchantError, MerchantErrorText } from "./MerchantError";
import { makeFixtureBookings } from "./__fixtures__/bookings";
import { applyDashboardQuery } from "./query";
import { SAVED_VIEWS, applySavedView, type SavedViewId } from "./savedViews";
import type { StudioPage } from "./StudioDashboard";
import type { AgStudioApi } from "ag-studio";
import { AskBox, type AppliedQuery } from "./AskBox";
import { Badge } from "./Badge";
import { labelRows, usePaymentMode } from "./modes";
import { studioInstanceKey, studioRowsSignature } from "./studioInstance";

const LazyStudioDashboard = dynamic(() => import("./StudioDashboard"), {
  ssr: false,
  loading: () => <div className="m-skel" role="status">Loading AG Studio dashboard...</div>,
});
// Every render of the Studio wrapper makes Studio re-apply its panels, which takes the assistant out of
// the page and puts it back (the message box loses focus). This page re-renders on every 30 s refresh,
// so Studio only renders when one of its own props really changed.
const StudioDashboard = memo(LazyStudioDashboard);

/** The same array for as long as nothing Studio shows has changed, so a refresh without news leaves Studio untouched. */
function useStableStudioRows(rows: MerchantBookingRow[]): MerchantBookingRow[] {
  const signature = useMemo(() => studioRowsSignature(rows), [rows]);
  const [stable, setStable] = useState({ signature, rows });
  if (stable.signature === signature) return stable.rows;
  setStable({ signature, rows });
  return rows;
}

type Segment = "SANDBOX" | "FIXTURE" | "BOTH";
const SEGMENT_LABEL: Record<Segment, string> = { SANDBOX: "Sandbox", FIXTURE: "Fixture", BOTH: "All" };

export interface DashboardClientProps {
  /** AG Studio licence key from the server env (a configuration value; never logged). */
  licenseKey?: string;
  /** Dev-only ?fixtures=1 mode (always false in production). */
  fixtures: boolean;
  /** Studio AI assistant is only offered when the server can serve it. */
  aiEnabled: boolean;
  /** The signed-in merchant's name (demo sign-in can pick any demo venue); null when unknown. */
  merchantName?: string | null;
}

export default function DashboardClient({ licenseKey, fixtures, aiEnabled, merchantName = null }: DashboardClientProps) {
  const router = useRouter();
  const [rawRows, setRows] = useState<MerchantBookingRow[] | null>(null);
  const paymentMode = usePaymentMode();
  // Re-label by provider: only PayPal-provider rows are "sandbox"; FIXTURE-paid outings are fixtures too.
  const rows = useMemo(() => (rawRows ? labelRows(rawRows, paymentMode) : null), [rawRows, paymentMode]);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [segment, setSegment] = useState<Segment | null>(null);
  const [applied, setApplied] = useState<AppliedQuery | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [assistant, setAssistant] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const askRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<StudioPage>("bookings");
  const [viewId, setViewId] = useState<SavedViewId | "">("");
  const apiRef = useRef<AgStudioApi | null>(null);
  const viewRef = useRef<SavedViewId | "">("");

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = fixtures ? makeFixtureBookings() : await fetchBookings();
      setRows(data);
      setError(null);
      setLoadedAt(new Date());
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace("/merchant/login");
        return;
      }
      setError(describeMerchantError(e));
    } finally {
      setRefreshing(false);
    }
  }, [fixtures, router]);

  useEffect(() => {
    // Fetch-on-mount: the setState calls happen after awaiting the network.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    if (fixtures) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load, fixtures]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return { sandbox: all.filter((r) => !r.isFixture).length, fixture: all.filter((r) => r.isFixture).length };
  }, [rows]);

  // Default: show real sandbox rows if any exist, otherwise the fixtures (never silently mixed).
  const suggestedSegment: Segment = counts.sandbox > 0 || counts.fixture === 0 ? "SANDBOX" : "FIXTURE";
  // The default is settled once, when there are rows and their payment mode is known. After that only the
  // merchant changes the data source: a refresh that brings the first sandbox booking must not swap the
  // whole dashboard, and the assistant's chat with it, under someone who is using it.
  const [startSegment, setStartSegment] = useState<Segment | null>(null);
  if (startSegment === null && paymentMode !== null && (rows?.length ?? 0) > 0) setStartSegment(suggestedSegment);
  const activeSegment: Segment = segment ?? startSegment ?? suggestedSegment;

  const currency = useMemo(() => {
    const tally = new Map<string, number>();
    for (const r of rows ?? []) tally.set(r.currency, (tally.get(r.currency) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
  }, [rows]);

  const scoped = useMemo(() => {
    const base = (rows ?? []).filter((r) => r.currency === currency);
    return base.filter((r) => (activeSegment === "BOTH" ? true : activeSegment === "FIXTURE" ? r.isFixture : !r.isFixture));
  }, [rows, activeSegment, currency]);

  const visible = useMemo(() => applyDashboardQuery(scoped, applied?.query ?? null), [scoped, applied]);
  const studioRows = useStableStudioRows(visible);
  const otherCurrency = (rows ?? []).filter((r) => r.currency !== currency).length;

  // Never keyed on the row values: a refresh must update the running Studio, not rebuild it (see studioInstanceKey).
  const studioKey = studioInstanceKey({ segment: activeSegment, appliedQueryId: applied?.id ?? 0, currency, rows: visible });
  const openOuting = useCallback((id: string) => router.push(`/merchant/outings/${id}`), [router]);
  const onStudioApi = useCallback((api: AgStudioApi) => {
    apiRef.current = api;
    if (viewRef.current) applySavedView(api, viewRef.current);
  }, []);

  const onApply = useCallback((q: AppliedQuery) => {
    setApplied(q);
    askRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="m-page">
      <div className="m-title-row">
        <div>
          <h1 className="m-h1">Bookings</h1>
          <p className="m-sub">
            Group bookings for {merchantName ?? "your venue"}. Authorized holds are not revenue.
            {loadedAt && <> Updated {loadedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}.</>}
          </p>
        </div>
        <span className="m-spacer" />
        {fixtures && <Badge tone="fixture">Dev fixtures mode (?fixtures=1)</Badge>}
        {aiEnabled && (
          <button type="button" className="m-btn" aria-pressed={assistant} onClick={() => setAssistant((v) => !v)}>
            <Bot size={16} aria-hidden /> {assistant ? "Hide assistant" : "Ask the assistant"}
          </button>
        )}
        <button type="button" className="m-btn" onClick={() => void load()} disabled={refreshing} aria-label="Refresh bookings">
          <RefreshCw size={16} aria-hidden /> {refreshing ? "Refreshing" : "Refresh"}
        </button>
      </div>

      <div className="m-seg-row">
        <div className="m-seg" role="group" aria-label="Data source">
          {(["SANDBOX", "FIXTURE", "BOTH"] as Segment[]).map((s) => (
            <button key={s} type="button" aria-pressed={activeSegment === s} onClick={() => setSegment(s)}>
              {SEGMENT_LABEL[s]}
              {s !== "BOTH" && <span className="m-sr">{` (${s === "SANDBOX" ? counts.sandbox : counts.fixture} outings)`}</span>}
            </button>
          ))}
        </div>
        <span className="m-footnote" style={{ margin: 0 }}>{counts.sandbox} paid through PayPal sandbox · {counts.fixture} simulated (Fixture)</span>
      </div>

      {activeSegment === "BOTH" && (
        <div className="m-banner" role="note" data-tone="danger">
          <AlertTriangle size={18} aria-hidden />
          <span>These totals mix PayPal sandbox payments with simulated ones. Simulated bookings are marked Fixture in the table. Pick Sandbox or Fixture for totals that mean one thing.</span>
        </div>
      )}
      {/* No banner for the Fixture segment: the header badge and the per-row "Fixture" label already say it. */}
      {activeSegment === "SANDBOX" && (
        <div className="m-banner" role="note" data-tone="info">
          <Info size={18} aria-hidden />
          <span>Showing bookings paid through PayPal&apos;s sandbox: PayPal&apos;s own test system, with test money. Simulated demo bookings are under Fixture.</span>
        </div>
      )}
      {otherCurrency > 0 && (
        <div className="m-banner" role="note"><AlertTriangle size={18} aria-hidden /><span>{otherCurrency} outing(s) in another currency are hidden; totals are never converted.</span></div>
      )}

      {error && (
        <div className="m-banner" role="alert" data-tone="danger">
          <AlertTriangle size={18} aria-hidden />
          <span><MerchantErrorText error={error} /> <button type="button" className="m-btn m-btn-sm" onClick={() => void load()}>Try again</button></span>
        </div>
      )}

      <div ref={askRef} style={{ scrollMarginTop: 12 }}><AskBox applied={applied} onApply={onApply} onClear={() => setApplied(null)} fixtures={fixtures} /></div>
      {rows && visible.length > 0 && (
        <div className="m-studio-bar">
          <div className="m-tabs" role="tablist" aria-label="Dashboard pages">
            {([["bookings", "Bookings"], ["money", "Money"]] as [StudioPage, string][]).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={page === id} onClick={() => setPage(id)}>{label}</button>
            ))}
          </div>
          <label className="m-view">
            <span className="m-sr">Saved views</span>
            <select
              aria-label="Saved views"
              value={viewId}
              onChange={(e) => {
                const v = e.target.value as SavedViewId | "";
                viewRef.current = v;
                setViewId(v);
                if (apiRef.current) applySavedView(apiRef.current, v || null);
              }}
            >
              <option value="">Saved views: all bookings</option>
              {SAVED_VIEWS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          {viewId && (
            <span className="m-view-note">
              {SAVED_VIEWS.find((v) => v.id === viewId)?.rule}{" "}
              <button type="button" className="m-btn m-btn-sm" onClick={() => { viewRef.current = ""; setViewId(""); if (apiRef.current) applySavedView(apiRef.current, null); }}>Clear view</button>
            </span>
          )}
          <span className="m-view-note">Click any bar, outing or row to filter everything else. Both pages follow the same filters.</span>
        </div>
      )}

      <div id="studio-frame" className="m-studio-frame" aria-busy={!rows}>
        {!rows && !error && <div className="m-skel" role="status">Loading bookings...</div>}
        {!rows && error && <div className="m-skel">Bookings could not be loaded.</div>}
        {rows && visible.length === 0 && (
          <div className="m-skel" style={{ textAlign: "center", padding: 24 }}>
            <p>
              <strong>No bookings match.</strong>
              <br />
              {applied ? "Clear the filter above, or switch between Sandbox and Fixture." : activeSegment === "SANDBOX" ? "No PayPal sandbox bookings yet. Switch to Fixture to explore the demo bookings." : "Nothing to show yet."}
            </p>
          </div>
        )}
        {rows && visible.length > 0 && (
          <StudioDashboard
            key={studioKey}
            rows={studioRows}
            currency={currency}
            sort={applied?.query.sort ?? null}
            focus={applied?.query.focus ?? null}
            page={page}
            onApi={onStudioApi}
            licenseKey={licenseKey}
            aiEnabled={aiEnabled}
            mode={assistant ? "edit" : "view"}
            onOpenOuting={openOuting}
            onError={setStudioError}
          />
        )}
      </div>
      {studioError && <p className="m-footnote" role="status">AG Studio notice: {studioError}</p>}
      {/* The "click to filter" hint lives next to the page tabs; it is not repeated down here. */}
      {!licenseKey && <p className="m-footnote">AG Studio is running without a licence key (trial mode).</p>}
    </div>
  );
}
