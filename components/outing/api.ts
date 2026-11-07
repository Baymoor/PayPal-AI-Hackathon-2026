/** Thin client for the documented HTTP API (docs/CONTRACTS.md). Errors carry the server's `{error:{code,message}}`. */
import type { OutingView } from "@/lib/contracts/views";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    /** From the Retry-After header (429 / 503), so error copy can say how long to wait. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Retry-After in seconds; the HTTP-date form is ignored (our server only sends seconds). */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

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
    // A dropped write may still have reached the server, so its outcome is unknown; a dropped read changed nothing.
    const isRead = (rest.method ?? "GET").toUpperCase() === "GET";
    throw new ApiError(isRead ? "NETWORK_READ" : "NETWORK", 0, "We couldn't reach the server. Check your connection and try again.");
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
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      err?.code ?? (res.status === 401 ? "UNAUTHORIZED" : res.status === 404 ? "NOT_FOUND" : "HTTP_" + res.status),
      res.status,
      err?.message ?? `Request failed (${res.status})`,
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }
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
