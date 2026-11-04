import type { AgReportState, AgStudioApi } from "ag-studio";
import { f } from "./studioData";

/**
 * Saved views: preset page filters applied through Studio's report state
 * (api.getState / api.setState), not by re-rendering or remounting the dashboard.
 */
export type SavedViewId = "closing-missing" | "recovery" | "confirmed-week";

type PageFilters = NonNullable<NonNullable<AgReportState["pages"][number]["filter"]>["page"]>;

export interface SavedView {
  id: SavedViewId;
  label: string;
  /** Plain-language rule, shown next to the dropdown so the active filter is never hidden. */
  rule: string;
  filters: PageFilters;
}

export const SAVED_VIEWS: SavedView[] = [
  {
    id: "closing-missing",
    label: "Closing today with missing required",
    rule: "Open outings whose deadline is today and where at least one required person has not accepted.",
    filters: [
      { field: { id: f("status") }, model: { operator: "equals", value: "Collecting" } },
      { field: { id: f("closesTodayFlag") }, model: { operator: "equals", value: 1 } },
      { field: { id: f("missingRequired") }, model: { operator: "greaterThan", value: 0 } },
    ],
  },
  {
    id: "recovery",
    label: "Recovery in progress",
    rule: "Outings whose hold releases or refunds are pending, or that need attention.",
    filters: [{ field: { id: f("recovery") }, model: { operator: "isIn", value: ["Hold release pending", "Refund pending", "Needs attention"] } }],
  },
  {
    id: "confirmed-week",
    label: "Confirmed this week",
    rule: "Confirmed bookings that changed in the last 7 days (the data has no separate confirmation time).",
    filters: [
      { field: { id: f("status") }, model: { operator: "equals", value: "Confirmed" } },
      { field: { id: f("confirmedRecently") }, model: { operator: "equals", value: 1 } },
    ],
  },
];

/** Apply (or clear, with null) a saved view on every page of the report, resetting cross-filter selections. */
export function applySavedView(api: AgStudioApi<never> | AgStudioApi, viewId: SavedViewId | null): void {
  const view = SAVED_VIEWS.find((v) => v.id === viewId);
  const state = (api as AgStudioApi).getState();
  (api as AgStudioApi).setState({
    ...state,
    pages: state.pages.map((p) => ({
      ...p,
      crossFilter: undefined,
      filter: { ...p.filter, page: view ? view.filters : [] },
    })),
  });
}
