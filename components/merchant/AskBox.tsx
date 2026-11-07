"use client";

import { useState } from "react";
import { Search, Sparkles, X } from "lucide-react";
import type { DashboardQuery } from "@/lib/ai/types";
import type { FriendlyError } from "@/components/errors/friendlyError";
import { askDashboard, ApiError, type AskResult } from "./api";
import { describeMerchantCode, describeMerchantError, MerchantErrorText } from "./MerchantError";
import { fixtureAsk } from "./__fixtures__/bookings";
import { describeFilter, FIELD_LABEL } from "./query";
import { Badge } from "./Badge";

export interface AppliedQuery extends AskResult {
  question: string;
  id: number;
}

const EXAMPLE = "Show outings closing today with missing required participants";

/**
 * Safe natural-language box. The server returns a validated, whitelisted DashboardQuery
 * (filters / sort / focus); we re-validate it and apply it to the rows in the browser.
 * It has no way to call capture, void, refund or retry.
 */
export function AskBox({ applied, onApply, onClear, fixtures }: {
  applied: AppliedQuery | null;
  onApply: (q: AppliedQuery) => void;
  onClear: () => void;
  fixtures: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<FriendlyError | null>(null);

  async function submit(question: string) {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      const res: AskResult = fixtures
        ? { query: fixtureAsk(q) as DashboardQuery, source: "FIXTURE", model: null, warnings: [] }
        : await askDashboard(q);
      onApply({ ...res, question: q, id: Date.now() });
    } catch (e) {
      // Anything that isn't an HTTP failure is the answer failing validation into a read-only filter.
      setError(e instanceof ApiError ? describeMerchantError(e) : describeMerchantCode("UNSAFE_FILTER"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="ask-label" className="m-card" style={{ padding: 16 }}>
      <form
        className="m-ask"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
      >
        <div className="m-ask-in">
          <Sparkles size={18} aria-hidden color="#B13624" />
          <label id="ask-label" htmlFor="ask-input" className="m-sr">Ask about your bookings</label>
          <input id="ask-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} maxLength={280} autoComplete="off" />
        </div>
        <button className="m-btn m-btn-primary" type="submit" disabled={busy || !text.trim()}>
          <Search size={16} aria-hidden /> {busy ? "Thinking..." : "Filter dashboard"}
        </button>
        <button className="m-btn" type="button" onClick={() => { setText(EXAMPLE); void submit(EXAMPLE); }} disabled={busy}>
          Try the example
        </button>
      </form>
      <p className="m-footnote" style={{ margin: "8px 0 0" }}>
        Read-only: your question only becomes filters on this page. It can never capture, void, refund or retry a payment.
      </p>
      <div aria-live="polite">
        {error && <p className="m-error" role="alert"><MerchantErrorText error={error} /></p>}
        {applied && (
          <>
            <div className="m-chips">
              <Badge tone={applied.source === "ANTHROPIC" ? "authorized" : "fixture"}>
                {applied.source === "ANTHROPIC" ? `AI: Anthropic${applied.model ? ` (${applied.model})` : ""}` : "Fixture AI (no model call)"}
              </Badge>
              {applied.query.filters.length === 0 && <span className="m-chip">No filters</span>}
              {applied.query.filters.map((f, i) => (
                <span key={i} className="m-chip">{describeFilter(f)}</span>
              ))}
              {applied.query.sort && <span className="m-chip">Sorted by {FIELD_LABEL[applied.query.sort.field]} ({applied.query.sort.direction === "asc" ? "ascending" : "descending"})</span>}
              {applied.query.focus && <span className="m-chip">Focus: {applied.query.focus.replace("_", " ").toLowerCase()}</span>}
              <button type="button" className="m-btn m-btn-sm" onClick={onClear}><X size={14} aria-hidden /> Clear filter</button>
            </div>
            <p className="m-explain"><strong>{`"${applied.question}"`}</strong>: {applied.query.explanation}</p>
            {applied.warnings.map((w, i) => <p key={i} className="m-footnote">Note: {w}</p>)}
          </>
        )}
      </div>
    </section>
  );
}
