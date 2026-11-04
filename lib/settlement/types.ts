/**
 * Shared types for the settlement engine.
 *
 * The engine never imports a concrete payment adapter. Every payment attempt
 * stores the provider it was created with, and the engine resolves the
 * adapter per attempt through a resolver, so tests inject an in-memory fake
 * and production wires `getPaymentProvider` from lib/payments.
 */
import type { PaymentProviderName } from "../domain/types";
import type { PaymentProvider } from "../payments/provider";
import type { AuditActor } from "../audit";

export type ProviderResolver = (name: PaymentProviderName) => PaymentProvider;

export interface WorkerContext {
  workerId: string;
  /** Application timestamp for rows the engine writes. Gating uses the DB clock. */
  now: Date;
}

export function workerActor(workerId: string): AuditActor {
  return `WORKER:${workerId}`;
}
