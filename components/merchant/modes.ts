"use client";
import { useEffect, useState } from "react";
import type { MerchantBookingRow } from "@/lib/contracts/views";
import { fetchHealth } from "./api";

export type AppPaymentMode = "PAYPAL_SANDBOX" | "FIXTURE" | "DISABLED";

/** This deployment's payment mode (from /api/health); null until known. */
export function usePaymentMode(): AppPaymentMode | null {
  const [mode, setMode] = useState<AppPaymentMode | null>(null);
  useEffect(() => {
    let alive = true;
    fetchHealth()
      .then((h) => {
        if (alive && (h.paymentMode === "PAYPAL_SANDBOX" || h.paymentMode === "FIXTURE" || h.paymentMode === "DISABLED")) setMode(h.paymentMode);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return mode;
}

/**
 * Honesty rule: a row counts as real PayPal sandbox money only when its payments provably went through the
 * PayPal provider. Seeded synthetic outings, outings paid with the FIXTURE simulator, mixed rows, and rows
 * without payments on a non-PayPal deployment (or while the mode is unknown) are all "Fixture".
 */
export function isFixtureMoney(row: Pick<MerchantBookingRow, "isFixture" | "provider">, mode: AppPaymentMode | null): boolean {
  if (row.isFixture) return true;
  if (row.provider === "PAYPAL") return false;
  if (row.provider === "FIXTURE" || row.provider === "MIXED") return true;
  return mode !== "PAYPAL_SANDBOX";
}

/** Rows whose `isFixture` means "not real PayPal sandbox money" (what every merchant label and filter uses). */
export function labelRows(rows: MerchantBookingRow[], mode: AppPaymentMode | null): MerchantBookingRow[] {
  return rows.map((r) => {
    const fixture = isFixtureMoney(r, mode);
    return fixture === r.isFixture ? r : { ...r, isFixture: fixture };
  });
}
