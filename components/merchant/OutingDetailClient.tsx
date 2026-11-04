"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import type { MerchantOperationRow, MerchantOutingDetail, MerchantParticipantRow } from "@/lib/contracts/views";
import { ApiError, fetchOutingDetail, retryOperation } from "./api";
import { makeFixtureBookings, makeFixtureDetail } from "./__fixtures__/bookings";
import { outingsGridTheme } from "./gridTheme";
import { formatInstant, formatMoney, redactRef } from "./format";
import {
  ATTENDANCE_LABEL, CLEANUP_LABEL, OP_KIND_LABEL, OP_STATUS_LABEL, OUTING_STATUS_LABEL, PAYMENT_STATUS_LABEL,
  cleanupTone, opStatusTone, outingTone, paymentTone,
} from "./labels";
import { Badge, ModeBadge } from "./Badge";
import { assessRow, VERDICT_LABEL } from "./readiness";
import { isFixtureMoney, usePaymentMode } from "./modes";

function toneRenderer<T>(text: (d: T) => string | null, tone: (d: T) => Parameters<typeof Badge>[0]["tone"]) {
  return function ToneCell(p: ICellRendererParams<T>) {
    if (!p.data) return null;
    const t = text(p.data);
    return t ? <Badge tone={tone(p.data)}>{t}</Badge> : <span>–</span>;
  };
}

export default function OutingDetailClient({ outingId, fixtures }: { outingId: string; fixtures: boolean }) {
  const router = useRouter();
  const [detail, setDetail] = useState<MerchantOutingDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [retrying, setRetrying] = useState<MerchantOperationRow | null>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const backHref = fixtures ? "/merchant?fixtures=1" : "/merchant";
  const paymentMode = usePaymentMode();

  const load = useCallback(async () => {
    try {
      if (fixtures) {
        const b = makeFixtureBookings().find((r) => r.outingId === outingId);
        if (!b) throw new ApiError(404, "Outing not found in fixtures.");
        setDetail(makeFixtureDetail(b));
      } else {
        setDetail(await fetchOutingDetail(outingId));
      }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace("/merchant/login");
        return;
      }
      setError({ status: e instanceof ApiError ? e.status : 0, message: e instanceof Error ? e.message : "Could not load this outing." });
    }
  }, [fixtures, outingId, router]);

  useEffect(() => {
    // Fetch-on-mount: the setState calls happen after awaiting the network.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (retrying && !d.open) d.showModal();
    if (!retrying && d.open) d.close();
  }, [retrying]);

  async function confirmRetry() {
    if (!retrying) return;
    setRetryBusy(true);
    try {
      if (!fixtures) await retryOperation(retrying.operationId);
      setNotice({ tone: "info", text: fixtures ? "Fixture mode: no request was sent." : `Retry queued for ${OP_KIND_LABEL[retrying.kind].toLowerCase()} (${retrying.participantName}). The same operation will be re-sent with its original idempotency key.` });
      setRetrying(null);
      await load();
    } catch (e) {
      setNotice({ tone: "danger", text: e instanceof Error ? e.message : "Retry failed." });
      setRetrying(null);
    } finally {
      setRetryBusy(false);
    }
  }

  const currency = detail?.booking.currency ?? "USD";
  const money = useCallback((v: number | null | undefined) => formatMoney(v, currency), [currency]);

  const participantCols = useMemo<ColDef<MerchantParticipantRow>[]>(() => [
    { field: "displayName", headerName: "Participant", pinned: "left", minWidth: 150 },
    { headerName: "Type", valueGetter: (p) => (p.data?.payerType === "SPONSORED" ? "Sponsored ($0)" : "Payer"), minWidth: 120 },
    { headerName: "Required?", valueGetter: (p) => (p.data?.required ? "Required" : "Optional"), minWidth: 105 },
    { headerName: "Attendance", field: "attendance", cellRenderer: toneRenderer<MerchantParticipantRow>((d) => ATTENDANCE_LABEL[d.attendance], (d) => (d.attendance === "ACCEPTED" ? "captured" : d.attendance === "PENDING" ? "pending" : "cancelled")), minWidth: 125 },
    { headerName: "Consent", valueGetter: (p) => !p.data?.consentQuoteVersion ? "No consent" : `v${p.data.consentQuoteVersion} ${p.data.consentCurrent ? "(current)" : "(superseded)"}`, minWidth: 140 },
    { headerName: "Payment", field: "paymentStatus", cellRenderer: toneRenderer<MerchantParticipantRow>((d) => (d.paymentStatus ? PAYMENT_STATUS_LABEL[d.paymentStatus] : null), (d) => paymentTone(d.paymentStatus)), minWidth: 170 },
    { headerName: "Timing", valueGetter: (p) => (!p.data?.paymentStatus ? "–" : p.data.late ? "Late (not counted)" : "On time"), minWidth: 140 },
    { headerName: "Order ref", valueGetter: (p) => redactRef(p.data?.orderRef), minWidth: 100 },
    { headerName: "Auth ref", valueGetter: (p) => redactRef(p.data?.authorizationRef), minWidth: 100 },
    { headerName: "Capture ref", valueGetter: (p) => redactRef(p.data?.captureRef), minWidth: 110 },
    { headerName: "Refund ref", valueGetter: (p) => redactRef(p.data?.refundRef), minWidth: 105 },
    { field: "authorizedMinor", headerName: "Authorized hold", type: "rightAligned", valueFormatter: (p) => money(p.value), minWidth: 135 },
    { field: "allocationMinor", headerName: "Final allocated", type: "rightAligned", valueFormatter: (p) => (p.value === null ? "–" : money(p.value)), minWidth: 130 },
    { field: "capturedMinor", headerName: "Captured", type: "rightAligned", valueFormatter: (p) => money(p.value), minWidth: 110 },
    { field: "refundedMinor", headerName: "Refunded", type: "rightAligned", valueFormatter: (p) => money(p.value), minWidth: 110 },
  ], [money]);

  const opCols = useMemo<ColDef<MerchantOperationRow>[]>(() => [
    { field: "participantName", headerName: "Participant", minWidth: 150 },
    { headerName: "Operation", valueGetter: (p) => (p.data ? OP_KIND_LABEL[p.data.kind] : ""), minWidth: 120 },
    { headerName: "Status", field: "status", cellRenderer: toneRenderer<MerchantOperationRow>((d) => OP_STATUS_LABEL[d.status], (d) => opStatusTone(d.status)), minWidth: 120 },
    { field: "amountMinor", headerName: "Amount", type: "rightAligned", valueFormatter: (p) => money(p.value), minWidth: 105 },
    { field: "attempts", headerName: "Attempts", type: "rightAligned", minWidth: 100 },
    { field: "providerStatus", headerName: "Provider status", valueFormatter: (p) => p.value ?? "–", minWidth: 130 },
    { field: "lastError", headerName: "Last error", valueFormatter: (p) => p.value ?? "–", flex: 1, minWidth: 220, tooltipField: "lastError" },
    { field: "updatedAt", headerName: "Updated", valueFormatter: (p) => formatInstant(p.value), minWidth: 170 },
    {
      headerName: "Action",
      pinned: "right",
      sortable: false,
      minWidth: 120,
      cellRenderer: (p: ICellRendererParams<MerchantOperationRow>) =>
        p.data?.canRetry ? (
          <button type="button" className="m-btn m-btn-sm" onClick={() => setRetrying(p.data!)} aria-label={`Retry ${OP_KIND_LABEL[p.data.kind]} for ${p.data.participantName}`}>
            <RotateCcw size={14} aria-hidden /> Retry
          </button>
        ) : (
          <span className="m-footnote">No action</span>
        ),
    },
  ], [money]);

  if (error) {
    return (
      <div className="m-page">
        <Link href={backHref} className="m-back"><ArrowLeft size={16} aria-hidden /> Back to bookings</Link>
        <div className="m-banner" role="alert" data-tone="danger">
          <AlertTriangle size={18} aria-hidden />
          <span>{error.status === 404 ? "This outing was not found, or it is not booked with your merchant account." : error.message} <button className="m-btn m-btn-sm" onClick={() => void load()}>Try again</button></span>
        </div>
      </div>
    );
  }
  if (!detail) {
    return <div className="m-page" role="status" aria-busy="true"><p className="m-sub">Loading outing...</p></div>;
  }

  const b = detail.booking;
  const q = detail.quote;
  const open = b.status === "COLLECTING";
  const ready = open ? assessRow(b) : null;

  return (
    <div className="m-page">
      <Link href={backHref} className="m-back"><ArrowLeft size={16} aria-hidden /> Back to bookings</Link>
      <div className="m-title-row">
        <div>
          <h1 className="m-h1">{b.title}</h1>
          <p className="m-sub">{b.offeringName ?? "No offering selected"} · activity {formatInstant(b.activityAt)}</p>
        </div>
        <span className="m-spacer" />
        <Badge tone={outingTone(b.status)}>{OUTING_STATUS_LABEL[b.status]}</Badge>
        {b.recoveryStatus !== "NONE" && <Badge tone={cleanupTone(b.recoveryStatus)}>Recovery: {CLEANUP_LABEL[b.recoveryStatus]}</Badge>}
        <ModeBadge fixture={isFixtureMoney(b, paymentMode)} />
      </div>

      {notice && <div className="m-banner" role="status" data-tone={notice.tone === "danger" ? "danger" : "info"}><span>{notice.text}</span></div>}

      <section className="m-card" aria-label="Booking summary" style={{ marginBottom: 16 }}>
        <dl className="m-summary" style={{ margin: 0 }}>
          <div className="m-stat"><dt>Closing time</dt><dd className="m-sm">{formatInstant(b.deadlineAt)}</dd></div>
          <div className="m-stat"><dt>Required accepted</dt><dd>{b.requiredAccepted} / {b.requiredInvited}</dd></div>
          <div className="m-stat"><dt>Payers authorized</dt><dd>{b.payersAuthorized}{b.minPayers !== null ? ` / ${b.minPayers} min` : ""}</dd></div>
          <div className="m-stat"><dt>Authorized holds (not revenue)</dt><dd>{money(b.authorizedTotalMinor)}</dd></div>
          <div className="m-stat"><dt>Final allocated</dt><dd>{money(b.allocatedTotalMinor)}</dd></div>
          <div className="m-stat"><dt>Captured</dt><dd>{money(b.capturedTotalMinor)}</dd></div>
          <div className="m-stat"><dt>Refunded</dt><dd>{money(b.refundedTotalMinor)}</dd></div>
          {ready && <div className="m-stat"><dt>Readiness</dt><dd className="m-sm">{VERDICT_LABEL[ready.verdict]}: {ready.reasons.join(". ")}</dd></div>}
        </dl>
      </section>

      <div className="m-two">
        <section className="m-card" aria-labelledby="quote-h">
          <h2 className="m-h2" id="quote-h">Quote terms</h2>
          {q ? (
            <dl className="m-terms">
              <dt>Version</dt><dd>v{q.version}</dd>
              <dt>Total ({q.pricingModel === "FIXED_TOTAL" ? "fixed" : "per attendee"})</dt><dd>{money(q.totalMinor)}</dd>
              <dt>Per-payer cap</dt><dd>{money(q.capMinor)}</dd>
              <dt>Min payers / capacity</dt><dd>{q.minPayers} / {q.capacity}</dd>
              <dt>Commit deadline</dt><dd>{formatInstant(q.deadlineAt)}</dd>
              <dt>Activity</dt><dd>{formatInstant(q.activityAt)}</dd>
              <dt>Terms hash</dt><dd><code>{q.termsHash.slice(0, 12)}…</code></dd>
              <dt>Availability</dt><dd>{q.availabilitySource === "FIXTURE" ? "Demo catalogue (fixture)" : "Merchant API"}</dd>
              <dt>Sponsored</dt><dd>{q.sponsoredNames.length ? q.sponsoredNames.join(", ") : "None"}</dd>
            </dl>
          ) : (
            <p className="m-sub">No quote has been issued yet.</p>
          )}
        </section>
        <section className="m-card" aria-labelledby="tl-h">
          <h2 className="m-h2" id="tl-h">Timeline</h2>
          {detail.timeline.length === 0 ? (
            <p className="m-sub">No events yet.</p>
          ) : (
            <ol className="m-timeline">
              {[...detail.timeline].sort((a, c) => a.at.localeCompare(c.at)).map((t, i) => (
                <li key={i}><time dateTime={t.at}>{formatInstant(t.at)}</time><strong>{t.type}</strong> <span className="m-footnote">by {t.actor}</span></li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="m-card" aria-labelledby="part-h" style={{ marginBottom: 16 }}>
        <h2 className="m-h2" id="part-h">Participants</h2>
        <div className="m-grid-wrap">
          <AgGridReact<MerchantParticipantRow>
            theme={outingsGridTheme}
            rowData={detail.participants}
            columnDefs={participantCols}
            defaultColDef={{ sortable: true, resizable: true }}
            autoSizeStrategy={{ type: "fitCellContents" }}
            getRowId={(p) => p.data.participantId}
            overlayNoRowsTemplate="No participants yet"
            ensureDomOrder
            suppressCellFocus={false}
          />
        </div>
      </section>

      <section className="m-card" aria-labelledby="ops-h">
        <h2 className="m-h2" id="ops-h">Payment operations</h2>
        <p className="m-footnote" style={{ marginTop: -6 }}>Retry re-sends an existing operation only. It never creates a new capture or refund.</p>
        <div className="m-grid-wrap" style={{ height: Math.min(380, 120 + detail.operations.length * 42) }}>
          <AgGridReact<MerchantOperationRow>
            theme={outingsGridTheme}
            rowData={detail.operations}
            columnDefs={opCols}
            defaultColDef={{ sortable: true, resizable: true }}
            getRowId={(p) => p.data.operationId}
            overlayNoRowsTemplate="No payment operations yet"
          />
        </div>
      </section>

      <dialog ref={dialogRef} className="m-dialog" aria-labelledby="retry-h" onClose={() => setRetrying(null)}>
        {retrying && (
          <>
            <h2 className="m-h2" id="retry-h">Retry this operation?</h2>
            <p>
              This re-sends the <strong>same {OP_KIND_LABEL[retrying.kind].toLowerCase()}</strong> of <strong>{money(retrying.amountMinor)}</strong> for {retrying.participantName} with its original idempotency key. PayPal will not apply it twice.
            </p>
            {retrying.status === "UNKNOWN" && <p className="m-footnote">The last outcome is unknown. The system reconciles with PayPal before re-sending.</p>}
            <div className="m-dialog-actions">
              <button type="button" className="m-btn" onClick={() => setRetrying(null)} disabled={retryBusy}>Cancel</button>
              <button type="button" className="m-btn m-btn-primary" onClick={() => void confirmRetry()} disabled={retryBusy}>{retryBusy ? "Retrying..." : "Retry operation"}</button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
