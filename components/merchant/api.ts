import type { MerchantBookingRow, MerchantOutingDetail } from "@/lib/contracts/views";
import type { DashboardQuery } from "@/lib/ai/types";
import { parseDashboardQuery } from "./query";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new ApiError(res.status, msg ?? (res.status === 404 ? "This endpoint is not available yet." : `Request failed (${res.status}).`));
  }
  return body as T;
}

export const fetchBookings = () => request<MerchantBookingRow[]>("/api/merchant/bookings");
export const fetchOutingDetail = (id: string) => request<MerchantOutingDetail>(`/api/merchant/outings/${encodeURIComponent(id)}`);
export const retryOperation = (opId: string) =>
  request<unknown>(`/api/merchant/operations/${encodeURIComponent(opId)}/retry`, { method: "POST", body: "{}" });
export const merchantLogin = (password: string) =>
  request<unknown>("/api/merchant/login", { method: "POST", body: JSON.stringify({ password }) });
export const merchantDemoLogin = () => request<unknown>("/api/merchant/demo-login", { method: "POST", body: "{}" });
export const merchantLogout = () => request<unknown>("/api/merchant/logout", { method: "POST", body: "{}" });
export const fetchHealth = () => request<{ demoFixturesEnabled?: boolean; paymentMode?: string; aiMode?: string }>("/api/health");

export interface AskResult {
  query: DashboardQuery;
  source: "ANTHROPIC" | "FIXTURE";
  model: string | null;
  warnings: string[];
}

/**
 * POST /api/merchant/ai/query. Accepts either a bare DashboardQuery or an AiResult-style
 * envelope ({ source, model, output, warnings }); the query is always re-validated here.
 */
export async function askDashboard(question: string): Promise<AskResult> {
  const body = await request<Record<string, unknown>>("/api/merchant/ai/query", { method: "POST", body: JSON.stringify({ question }) });
  const inner = (body.output ?? body.query ?? body) as unknown;
  const query = parseDashboardQuery(inner);
  const src = (body.source ?? body.aiSource) === "ANTHROPIC" ? "ANTHROPIC" : "FIXTURE";
  return {
    query,
    source: src,
    model: typeof body.model === "string" ? body.model : null,
    warnings: Array.isArray(body.warnings) ? (body.warnings as unknown[]).map(String) : [],
  };
}
