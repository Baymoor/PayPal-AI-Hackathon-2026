/** Thin client for the documented HTTP API (docs/CONTRACTS.md). Errors carry the server's `{error:{code,message}}`. */
import type { OutingView } from "@/lib/contracts/views";
import { apiErrorFromResponse, networkError } from "@/components/errors/apiError";

// Re-exported so existing `import { ApiError } from "./api"` call sites keep working.
export { ApiError } from "@/components/errors/apiError";

export async function request<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...rest,
      headers: { accept: "application/json", ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw networkError(rest.method);
  }
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) throw apiErrorFromResponse(res, body);
  return body as T;
}

export interface InviteLink {
  participantId: string;
  displayName: string;
  link: string;
}

export const outingApi = {
  create: (organizerName: string, brief: string) =>
    request<{ outingId: string }>("/api/outings", { method: "POST", json: { organizerName, brief } }),
  get: (id: string) => request<OutingView>(`/api/outings/${id}`),
  startBudget: (id: string) => request(`/api/outings/${id}/start-budget`, { method: "POST" }),
  addInvitees: (id: string, names: string[], required?: boolean) =>
    request<{ invites: InviteLink[] }>(`/api/outings/${id}/invitees`, { method: "POST", json: { names, ...(required === undefined ? {} : { required }) } }),
  vote: (id: string, amountMinor: number) => request(`/api/outings/${id}/budget/vote`, { method: "POST", json: { amountMinor } }),
  reveal: (id: string) => request(`/api/outings/${id}/budget/reveal`, { method: "POST" }),
  newRound: (id: string) => request(`/api/outings/${id}/budget/round`, { method: "POST" }),
  agreeBudget: (id: string, amountMinor: number) => request(`/api/outings/${id}/budget/agree`, { method: "POST", json: { amountMinor } }),
  select: (id: string, offeringId: string) => request(`/api/outings/${id}/select`, { method: "POST", json: { offeringId } }),
  patchParticipant: (id: string, pid: string, patch: { payerType?: "PAYER" | "SPONSORED"; required?: boolean }) =>
    request(`/api/outings/${id}/participants/${pid}`, { method: "PATCH", json: patch }),
  open: (id: string, body: { activityAt: string; deadlineAt: string; minPayers: number }) =>
    request(`/api/outings/${id}/open`, { method: "POST", json: body }),
  respond: (id: string, response: "ACCEPT" | "DECLINE") => request(`/api/outings/${id}/respond`, { method: "POST", json: { response } }),
  consent: (id: string, termsHash: string) => request(`/api/outings/${id}/consent`, { method: "POST", json: { termsHash } }),
  pay: (id: string) => request<{ approveUrl: string }>(`/api/outings/${id}/payments`, { method: "POST" }),
  withdraw: (id: string) => request(`/api/outings/${id}/withdraw`, { method: "POST" }),
  cancel: (id: string) => request(`/api/outings/${id}/cancel`, { method: "POST" }),
  /** Demo mode only: act as another participant of an outing this browser is already part of. */
  switchPersona: (participantId: string) =>
    request<{ outingId: string; participantId: string }>("/api/demo/persona", { method: "POST", json: { participantId } }),
};

/** The action surface the presentational screens use. OutingClient wires it to the API; the dev preview stubs it. */
export interface OutingActions {
  startBudget(): Promise<void>;
  addInvitees(names: string[]): Promise<InviteLink[]>;
  vote(amountMinor: number): Promise<void>;
  reveal(): Promise<void>;
  newRound(): Promise<void>;
  agreeBudget(amountMinor: number): Promise<void>;
  select(offeringId: string): Promise<void>;
  patchParticipant(pid: string, patch: { payerType?: "PAYER" | "SPONSORED"; required?: boolean }): Promise<void>;
  open(body: { activityAt: string; deadlineAt: string; minPayers: number }): Promise<void>;
  respond(response: "ACCEPT" | "DECLINE"): Promise<void>;
  consent(termsHash: string): Promise<void>;
  /** Creates the payment attempt and resolves with the URL to send the buyer to. */
  pay(): Promise<string>;
  withdraw(): Promise<void>;
  cancel(): Promise<void>;
  refresh(): Promise<void>;
}
