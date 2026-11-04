import type { AgDefaultWidgetDefinition } from "ag-studio";
import { createWidgets, type AgRegistry } from "ag-studio-react";
import { readinessDef } from "./ReadinessWidget";
import { moneyFlowDef } from "./MoneyFlowWidget";
import { OutingLinkCell } from "./OutingLinkCell";
import { f } from "./studioData";

/** Registry of our custom Studio widgets (Booking readiness + Money flow). */
export interface OutingsRegistry extends AgRegistry {
  widgets: readonly [...AgDefaultWidgetDefinition[], typeof readinessDef, typeof moneyFlowDef];
}

export const outingsWidgets = createWidgets<OutingsRegistry>({
  additionalTypes: [readinessDef, moneyFlowDef],
  // Bookings grid: the Outing name cell is a real <a href> to /merchant/outings/<id>.
  // Cast: the override type collapses to `never` for a registry that mixes default and custom widgets.
  overrides: [{ id: "grid", options: { createCellRenderer: (field: { fieldId?: string; key?: string }) => ((field.fieldId ?? field.key) === f("title") ? OutingLinkCell : undefined) } }] as never,
  menu: [{ label: "Outings", widgetIds: ["booking-readiness", "money-flow"] }],
});
