/** Browser client for the judge sign-in routes (app/api/judge/*). */

export interface JudgeSessionState {
  /** False when this deployment has no judge gate (JUDGE_PASSWORD unset): nothing about judges is shown. */
  gateEnabled: boolean;
  signedIn: boolean;
}

/** A failed judge API call, carrying the server's own sentence (e.g. "Wrong username or password"). */
export class JudgeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JudgeApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new JudgeApiError(res.status, body?.error?.message ?? "Something went wrong. Please try again.");
  return body as T;
}

export const judgeLogin = (username: string, password: string) =>
  request<{ ok: true }>("/api/judge/login", { method: "POST", body: JSON.stringify({ username, password }) });
export const judgeLogout = () => request<{ ok: true }>("/api/judge/logout", { method: "POST", body: "{}" });
export const fetchJudgeSession = () => request<JudgeSessionState>("/api/judge/session");
