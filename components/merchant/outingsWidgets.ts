import type { AgDefaultWidgetDefinition } from "ag-studio";
import { createWidgets, type AgRegistry } from "ag-studio-react";
import { readinessDef } from "./ReadinessWidget";
import { moneyFlowDef } from "./MoneyFlowWidget";

/** Registry of our custom Studio widgets (Booking readiness + Money flow). */
export interface OutingsRegistry extends AgRegistry {
  widgets: readonly [...AgDefaultWidgetDefinition[], typeof readinessDef, typeof moneyFlowDef];
}

export const outingsWidgets = createWidgets<OutingsRegistry>({
  additionalTypes: [readinessDef, moneyFlowDef],
  menu: [{ label: "Outings", widgetIds: ["booking-readiness", "money-flow"] }],
});
