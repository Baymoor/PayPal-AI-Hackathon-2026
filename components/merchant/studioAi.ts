/**
 * AG Studio's built-in AI assistant, wired to our own server route.
 * - `merchantStudioAdapter` is an AgLlmAdapter that POSTs Studio's request to
 *   /api/merchant/ai/studio (session-gated, rate-limited, Anthropic-backed) and parses NDJSON.
 * - the harness keeps ONLY read-only view/query tools and filter tools. Widget/expression
 *   editing tools are removed here as well as on the server.
 * Requires the AG Studio AI module (PRO-AI licence; trial mode unlocks everything).
 */
import {
  createAiHarness,
  directLlmRunner,
  type AgAiEvent,
  type AgAiHarnessSetup,
  type AgAiTool,
  type AgAnyAiAgentDefinition,
  type AgLlmAdapter,
  type AgLlmRequest,
  type AgLlmResponse,
  type AgLlmResponseHandler,
} from "ag-studio";

type Line = { kind: "event"; event: AgAiEvent } | { kind: "done"; response: AgLlmResponse };

async function* lines(req: AgLlmRequest, signal: AbortSignal | undefined, out: { response?: AgLlmResponse }) {
  // The model id is chosen server-side; never send more than the server needs.
  const { model: _model, ...body } = req;
  void _model;
  const res = await fetch("/api/merchant/ai/studio", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let message = `The assistant is unavailable (${res.status}).`;
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message;
    } catch { /* keep default */ }
    throw new Error(message);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const p of parts) {
      if (!p.trim()) continue;
      const m = JSON.parse(p) as Line;
      if (m.kind === "event") yield m.event;
      else out.response = m.response;
    }
  }
}

export const merchantStudioAdapter: AgLlmAdapter = {
  executeTurn(request, options): AgLlmResponseHandler {
    const out: { response?: AgLlmResponse } = {};
    let ok!: (r: AgLlmResponse) => void;
    let fail!: (e: unknown) => void;
    const complete = new Promise<AgLlmResponse>((a, b) => { ok = a; fail = b; });
    complete.catch(() => undefined); // surfaced through the stream too
    async function* stream() {
      try {
        yield* lines(request, options?.signal, out);
        if (out.response) ok(out.response);
        else fail(new Error("The assistant ended without a response."));
      } catch (e) {
        fail(e);
        throw e;
      }
    }
    return { stream: stream(), complete };
  },
};

const ALLOWED = new Set([
  "view_schema", "view_report", "view_page", "view_widget", "execute_query",
  "add_page_filter", "remove_page_filter", "add_widget_filter", "remove_widget_filter",
  "view_plan", "create_plan", "update_plan", "clear_plan", "delegate_to", "complete_task", "rename_thread",
]);

const readOnly = (d: AgAnyAiAgentDefinition): AgAnyAiAgentDefinition => ({
  ...d,
  tools: (ctx, params) => (d.tools?.(ctx, params) ?? []).filter((t: AgAiTool) => ALLOWED.has(t.name)),
});

export function createAiSetup(): AgAiHarnessSetup {
  return ({ api }) =>
    createAiHarness(api, ({ builtIn }) => ({
      primary: "lead",
      agents: (["lead", "data", "planning"] as const).map((id) => directLlmRunner({ ...readOnly(builtIn[id]), adapter: merchantStudioAdapter })),
      promptStarters: [
        { label: "Who is not ready?", prompt: "Which open outings are at risk and why? Remember authorized holds are not revenue." },
        { label: "Money summary", prompt: "Summarise authorized holds, captured and refunded money by status." },
      ],
    }));
}
