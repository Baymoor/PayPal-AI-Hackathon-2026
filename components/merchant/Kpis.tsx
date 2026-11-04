import type { MerchantBookingRow } from "@/lib/contracts/views";
import { formatMoney } from "./format";

export interface KpiValues {
  openOutings: number;
  closingToday: number;
  capturedMinor: number;
  refundsPending: number;
  refundsPendingMinor: number;
}

export function computeKpis(rows: MerchantBookingRow[]): KpiValues {
  return {
    openOutings: rows.filter((r) => r.status === "COLLECTING").length,
    closingToday: rows.filter((r) => r.status === "COLLECTING" && r.closesToday).length,
    // Captured (confirmed) = money actually collected on confirmed bookings, not holds
    capturedMinor: rows.filter((r) => r.status === "CONFIRMED").reduce((a, r) => a + r.capturedTotalMinor, 0),
    refundsPending: rows.reduce((a, r) => a + r.refundPendingCount, 0),
    refundsPendingMinor: rows.filter((r) => r.recoveryStatus === "REFUND_PENDING").reduce((a, r) => a + Math.max(0, r.capturedTotalMinor - r.refundedTotalMinor), 0),
  };
}

export function Kpis({ rows, currency, mixed }: { rows: MerchantBookingRow[]; currency: string; mixed: boolean }) {
  const k = computeKpis(rows);
  const scope = mixed ? "Sandbox + fixtures combined" : "";
  return (
    <section className="m-kpis" aria-label="Key figures">
      <div className="m-kpi">
        <p className="m-kpi-label">Open outings</p>
        <p className="m-kpi-value">{k.openOutings}</p>
        <p className="m-kpi-note">Collecting commitments now {scope && `· ${scope}`}</p>
      </div>
      <div className="m-kpi">
        <p className="m-kpi-label">Closing today</p>
        <p className="m-kpi-value">{k.closingToday}</p>
        <p className="m-kpi-note">Open outings with a deadline today</p>
      </div>
      <div className="m-kpi">
        <p className="m-kpi-label">Captured (confirmed bookings)</p>
        <p className="m-kpi-value">{formatMoney(k.capturedMinor, currency)}</p>
        <p className="m-kpi-note">Money collected. Authorized holds are not counted. {scope}</p>
      </div>
      <div className="m-kpi">
        <p className="m-kpi-label">Refunds pending</p>
        <p className="m-kpi-value">{k.refundsPending}</p>
        <p className="m-kpi-note">{k.refundsPending ? `${formatMoney(k.refundsPendingMinor, currency)} captured, awaiting refund` : "Nothing waiting"}</p>
      </div>
    </section>
  );
}
