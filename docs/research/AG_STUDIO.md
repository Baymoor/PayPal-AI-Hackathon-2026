# AG Studio + AG Grid implementation guide (Outings merchant dashboard)

Status: researched 2026-11-03 against the packages installed in this repo. Every code block below
was type-checked with `tsc --strict` (jsx `react-jsx`, `moduleResolution: bundler`) against the
installed `.d.ts` files, unless marked **UNVERIFIED**.

| Package | Installed | Notes |
| --- | --- | --- |
| `ag-studio` | 3.0.0 | commercial licence; `types: dist/types/main.d.ts`; ESM `dist/package/main.esm.mjs` (3.8 MB unminified, 1.8 MB min) |
| `ag-studio-react` | 3.0.0 | `types: dist/types/src/index.d.ts`; peer `react ^17 \|\| ^18 \|\| ^19` (React 19.3 is fine) |
| `ag-grid-community` / `ag-grid-react` | 36.2.0 | for the plain fallback grid and drill-down grid |
| `ag-grid-enterprise` 36.2.0, `ag-charts-enterprise` 14.2.0, `ag-stack` 36.2.0 | transitive | dependencies of `ag-studio`; already hoisted in `node_modules`; we never import them directly |

Sources, in the order used: installed `.d.ts` and bundle source (`node_modules/ag-studio/dist/**`),
package READMEs, and the sponsor reference repo
(`paypaldev/hackathon-paypal-ag-grid-boilerplate@5de114e`, **no licence, read for API patterns only,
nothing copied**). The official docs site (`www.ag-grid.com`) was **not reachable** from the research
sandbox (DNS blocked), so nothing here is taken from the docs pages; where the docs would normally
confirm a behaviour that I could only infer from the bundle, it is flagged.

---

## 1. Mounting AG Studio in the Next.js App Router

Facts:

- `ag-studio-react` ships **no `'use client'` directive**. `AgStudio` is a class component using
  lifecycle methods, so it can only be imported from a Client Component.
- **No CSS import is needed.** Studio injects its theme CSS from JS (the only static CSS in the
  React package is `.ag-studio-react-container { display: contents }`, injected for you). Do not
  import `ag-grid-community/styles/*.css` for Studio.
- Importing `ag-studio` / `ag-studio-react` and server-rendering `<AgStudio/>` in Node did **not**
  throw in my test (`renderToString` returned an empty `<div>` skeleton). Even so, treat Studio as
  browser-only: it measures its container, creates grids/charts in `componentDidMount`.
- Studio **fills its parent** (`height/width: 100%` of whatever contains it). The parent needs a real
  height; `THEME_DEFAULTS` has `studioMinWidth/Height: 600`, canvas min width 720.
- In Next 16 `next/dynamic(..., { ssr: false })` is only allowed **inside a Client Component**
  (confirmed in `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`).
- The bundle is large (Studio + AG Grid Enterprise + AG Charts Enterprise). Keep it off every other
  route by code-splitting it.

Recommended structure:

```
app/(merchant)/dashboard/page.tsx          // Server Component: auth, fetch data, pass plain JSON
app/(merchant)/dashboard/dashboard-client.tsx   // 'use client': next/dynamic(ssr:false) wrapper
app/(merchant)/dashboard/studio-dashboard.tsx   // 'use client': the real <AgStudio> (heavy)
```

```tsx
// dashboard-client.tsx
'use client';
import dynamic from 'next/dynamic';
import type { DashboardData } from './types';

const StudioDashboard = dynamic(() => import('./studio-dashboard'), {
  ssr: false,
  loading: () => <div className="h-full animate-pulse" />,
});

export default function DashboardClient(props: { data: DashboardData; licenseKey?: string }) {
  return (
    <div style={{ height: 'calc(100dvh - 64px)', width: '100%' }}>{/* explicit height */}
      <StudioDashboard {...props} />
    </div>
  );
}
```

```tsx
// studio-dashboard.tsx
'use client';
import { useMemo, useRef } from 'react';
import { enableStudioDevValidations, type AgStudioApi, type AgReportState } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';

if (process.env.NODE_ENV !== 'production') enableStudioDevValidations(); // dev-only console validation

export default function StudioDashboard({ data, licenseKey }: { data: DashboardData; licenseKey?: string }) {
  const apiRef = useRef<AgStudioApi | null>(null);
  const studioData = useMemo(() => buildStudioData(data), [data]);   // see section 2
  return (
    <AgStudioProvider licenseKey={licenseKey}>
      <AgStudio
        style={{ height: '100%', width: '100%' }}
        data={studioData}
        initialState={initialReport}      // read ONCE at creation
        theme={outingsTheme}              // section 6
        mode="view"                       // 'view' | 'edit'
        onApiReady={(e) => { apiRef.current = e.api; }}
        onStateUpdated={(e) => { /* e.state is the full AgReportState: persist it */ }}
      />
    </AgStudioProvider>
  );
}
```

`AgStudioProvider` props (verified): `{ modules?: AgStudioModule[]; licenseKey?: string; children }`.
The licence key is read once when the Studio instance is created and set **globally** through
`AgStudioLicenseManager.setLicenseKey`; supplying two different keys logs a "set more than once"
error. The imperative equivalents are `AgStudioLicenseManager.setLicenseKey(key)` and
`AgStudioModuleRegistry.registerModules([...])` (both exported by `ag-studio`).

Other facts about `AgStudio` (`AgStudioReactProperties = AgStudioProperties & { modules?, style?, className?, studioProperties? }`):

- Events: `onApiReady`, `onStudioReady`, `onStateUpdated`, `onRenderStateChanged`,
  `onStudioPreDestroyed`, `onErrorRaised` (use `onErrorRaised` to surface engine/query errors).
- `AgStudio` is a class: `ref.current.api` is valid only after `apiReady` fired (`AgStudioRef`).
- `initialState` is `@initial` (read once). Afterwards drive it with `api.setState(...)`; do not
  re-pass a new `initialState` expecting it to reset.
- `mode` can change at runtime; state carries across. `history.onModeChange` can discard undo history.
- `panels`, `page`, `layout`, `suppressKeyboard`, `localeText`, `popupParent`, `themeCssLayer`,
  `styleNonce` exist (see `api/agStudioProperties.d.ts`).
- Studio does not store filters added by viewers in view mode (`enableFilterEditingInViewMode`); if
  they must survive reload, persist `onStateUpdated`'s state yourself.
- `AgStudioApi` (verified): `getState`, `setState`, `undo`, `redo`, `getHistory`, `clearHistory`,
  `destroy`, `getProperty`, `setProperty`, `updateProperties`, `getStudioId`, `reload`,
  `getAiContext`, `getAiTools`, `defineAiTool`, `defineAiCommand`, `performWidgetAction`.

SSR/hydration safety net (what the sponsor repo does, in our own words): gate on "mounted" with
`useSyncExternalStore(() => () => {}, () => true, () => false)` and render a skeleton on the server.
`next/dynamic ssr:false` achieves the same with less code.

---

## 2. Data sources, fields, relationships, updates

`data` is `AgDataSourcesDefinition` (or a pre-built `AgDataEngine`):

```ts
import type { AgDataSourcesDefinition } from 'ag-studio';

interface OutingRow {
  id: string; title: string; deadline: string;        // ISO string
  requiredInvited: number; requiredAccepted: number;
  payersAuthorized: number; minPayers: number;
}

export function buildStudioData(rows: { outings: OutingRow[] /* + participants, payments */ }): AgDataSourcesDefinition {
  return {
    description:                      // AI-facing: put business rules here, the agent reads it
      'One row per outing. Readiness = required people accepted and enough payers authorized before the deadline.',
    sources: [
      {
        id: 'outings',                // table id; used in field ids as "outings.title"
        name: 'Outings',
        description: 'Planned group outings.',
        data: rows.outings,           // plain objects: string | number | boolean | Date | null
        fields: [                     // optional (inferred if omitted) but set it for names/formats
          { id: 'id', name: 'Outing ID', format: 'textFormat', hide: true },   // hidden but joinable
          { id: 'title', name: 'Outing', format: 'textFormat' },
          { id: 'deadline', name: 'Booking deadline', format: 'dateTimeFormat' },
          { id: 'requiredInvited', name: 'Required invited', format: 'integerFormat' },
          { id: 'requiredAccepted', name: 'Required accepted', format: 'integerFormat' },
          { id: 'payersAuthorized', name: 'Payers authorized', format: 'integerFormat' },
          { id: 'minPayers', name: 'Min payers', format: 'integerFormat' },
        ],
      },
    ],
    expressions: [                    // calculated measures, usable in widgets as { id: 'acceptRate' }
      {
        id: 'acceptRate', name: 'Required accept rate', format: 'percentageFormat', isMeasure: true,
        expression: {
          operator: 'divide',
          inputs: [
            { id: 'outings.requiredAccepted', aggregation: 'sum' },
            { id: 'outings.requiredInvited', aggregation: 'sum' },
          ],
        },
      },
    ],
  };
}
```

Verified type facts:

- Built-in formats (`AgFormats`): `integerFormat`, `decimalFormat`, `percentageFormat`,
  `currencyFormat`, `textFormat`, `dateFormat`, `dateTimeFormat`, `partialDateFormat`,
  `partialDateTimeFormat`, `booleanFormat`. Underlying data types: `string | number | boolean | date | datetime`.
  Format options live in `formatOptions: { format?: Intl.NumberFormat | string }`
  (currency, e.g. `{ format: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }) }`).
  Currency is not a field property: multi-currency data must be filtered by currency before summing (the reference repo says so in its dataset `description`).
- Date columns: the type says `Date`, but the reference passes ISO strings (`'2026-03-01'`,
  `'2026-03-01T10:00:00Z'`) for `dateFormat` / `dateTimeFormat` fields and works. Prefer ISO strings
  (JSON-safe across the server/client boundary). Use `field.accessor` (key or `(row)=>value`) to derive values.
- Aggregations: `sum | avg | min | max | count | countd | first | last`.
- Field reference in widget state: `{ id: 'table.field', aggregation?: ... }`. Calendar fragments use
  `calendar::month` style ids (`calendar::month`, `::year`, `::quarter`, `::week`, `::day`, `::dayOfWeek`) when a calendar is defined.
- `relationships`: data joins `{ id, source:{tableId,fieldId}, target:{tableId,fieldId}, type:
  'many-to-one'|'one-to-many'|'one-to-one'|'many-to-many', acceptFanout? }` and calendar bindings
  `{ id, source, target:{ calendarId }, truncate?: 'day'|'hour'|'minute' }`. Studio's data engine
  (in-browser) does the joins, so `participants.outingId -> outings.id` as `many-to-one` is how a
  drill-down table joins to its outing.
- `calendars: AgCalendar[]` gives a continuous date spine with `range` and `fragments` (see reference for a working shape: `{ id, label, range:{from:{type:'date',value}, to:{...}}, fragments:[...] }`).
- `options.fanout` warns/blocks when joins would duplicate summed measures.
- Async/lazy sources exist (`AgDataSourceDefinition` with `getData(tableId, fieldIds, options)`,
  `dataShape: 'row'|'column'`, `capabilities: {pagination, filter, sort}`, `pageSize`). Use only if the data is too big to ship to the browser; for the hackathon pass arrays.
- **Security note:** all source data is shipped to the browser and the in-page engine queries it. Only
  pass data the logged-in merchant may see; there is no server-side row security inside Studio.

Updating data: `data` is a normal reactive prop. The type docs say: *"If updated after initially
being set, only changes to synchronous data will be processed. Any other changes (adding/removing
sources, updating fields) are ignored."* The bundle contains an `updateData` path for existing
sources. So: keep source ids and field lists stable and pass a **new `data` object (memoised)** when
rows change (e.g. after `router.refresh()` or polling); to restructure, remount with a new `key`
(or `api.reload()`; **UNVERIFIED** semantics). `api.updateProperties({ data })` is the imperative equivalent.
Always `useMemo` the data object, or it is rebuilt on every render.

---

## 3. Initial report (pages, widgets, layout), filters, cross-filtering

The whole dashboard is one JSON object, `AgReportState`:

```ts
import type { AgReportState, AgPageState, AgWidgetLayoutState } from 'ag-studio';

const at = (xTrack: number, yTrack: number, xSpan: number, ySpan: number): AgWidgetLayoutState =>
  ({ xTrack, yTrack, xSpan, ySpan });                    // canvas = 24 columns; row height = studioCanvasRowHeight
const sum = (id: string) => ({ id, aggregation: 'sum' as const });

const overview: AgPageState = {
  id: 'overview',
  widgets: {
    'kpi-accepted': {
      type: 'value',                                      // KPI tile
      dataMapping: { value: [sum('outings.requiredAccepted')] },
      format: { title: { enabled: true, text: 'Required accepted' } },
    },
    'by-outing': {
      type: 'column-chart-grouped',
      dataMapping: {
        categoryKey: [{ id: 'outings.title' }],
        valueKey: [sum('outings.requiredAccepted'), sum('outings.requiredInvited')],
      },
      format: { title: { enabled: true, text: 'Accepted vs invited' } },
    },
    outings: {
      type: 'grid',
      dataMapping: { cols: [{ id: 'outings.title' }, { id: 'outings.deadline' }, sum('outings.payersAuthorized')] },
      sort: [{ field: { id: 'outings.deadline' }, direction: 'asc' }],
      format: { title: { enabled: true, text: 'Outings' } },
    },
  },
  widgetLayout: {
    'kpi-accepted': at(0, 0, 6, 7),
    'by-outing': at(6, 0, 18, 16),
    outings: at(0, 16, 24, 20),
  },
  filter: {                                               // page filters (Studio's filter panel)
    page: [{ field: { id: 'outings.title' }, model: { operator: 'contains', value: 'Dinner' } }],
  },
};

export const initialReport: AgReportState = { selectedPageId: 'overview', pages: [overview] };
```

Verified facts:

- `AgReportState = { pages: AgPageState[]; selectedPageId: string; panels?; schema?; version? }`.
  `AgPageState = { id; widgets?: Record<widgetId, widgetState>; widgetLayout?: Record<widgetId,
  {xTrack,yTrack,xSpan,ySpan}>; layout?; filter?: { page?: AgFilterState[]; widget?: Record<widgetId,
  AgFilterState[]> }; crossFilter?; selection? }`. Page titles are **not** part of state (the sponsor app keeps its own `pageTitles` map; Studio leaves page navigation to the host).
- Default widget `type` ids: `value`, `text`, `image`, `grid`, `pivot-grid`, `list-filter`,
  `button-filter`, `date-filter`, and charts `column-chart-grouped|stacked|stacked-100`,
  `bar-chart-grouped|stacked|stacked-100`, `line-chart`, `area-chart(-stacked|-stacked-100)`,
  `pie-chart`, `donut-chart`, `scatter-chart`, `bubble-chart`, `combo-chart-grouped-column-line`,
  `combo-chart-stacked-column-line`, `funnel-chart`, `cone-funnel-chart`, `pyramid-chart`,
  `treemap-chart`, `sunburst-chart`, `nightingale-chart`, `radar-line-chart`, `radar-area-chart`,
  `radial-bar-chart`, `radial-column-chart`, `radial-gauge`, `linear-gauge`.
- Data-mapping keys differ per type: `value` -> `value` (+`sparklineX`); column/bar/line charts ->
  `categoryKey`, `valueKey`, optional `legendKey`, `secondaryValueKey` (combo); `grid` -> `cols`;
  `pivot-grid` -> `rows`, `columns`, `values`; filter widgets -> `value`; gauges -> `value`. The exact
  interfaces are in `node_modules/ag-studio/dist/types/api/widgets/ag*.d.ts` (e.g. `agValueWidget.d.ts`);
  the compiler tells you when a key is wrong because `initialState` is typed.
- Filter operators (`AgDefaultFilterOperator`): `equals notEqual greaterThan lessThan greaterThanOrEqual
  lessThanOrEqual between inRelativeRange isNull isNotNull isUndefined isNotUndefined isBlank
  isNotBlank isNaN contains notContains startsWith endsWith isIn isTrue isFalse rank`.
  A page filter can be bound to an on-canvas filter widget with `filterWidgetId`.
- Reference-repo observation (not independently reproduced): a **relative date filter saved in state
  failed to apply on load in Studio 3.0** ("must be a two-element range") though it worked once chosen in the
  widget. Avoid pre-seeding `inRelativeRange` in `initialState`.

Cross-filtering (verified in types):

- Per widget `format.crossFilter: 'filter' | 'highlight' | 'none'` controls how that widget reacts to
  selections made elsewhere (`highlight` only for widget types whose `featureConfig.crossFilter.supportsHighlight` is true, mainly charts).
- Clicking a chart data point or grid selection creates a selection stored in the page's
  `crossFilter: { values: Record<widgetId, AgCrossFilterSelectionState[]> }` where each selection is
  `{type:'value', group, field, values[]}`, `{type:'range', group, field, from?, to?}` or
  `{type:'multiValue', group, values: {field,value}[][]}`.
- From a custom widget: `widgetApi.toggleCrossFilter({ type:'value', group: 0, field, value })`,
  `resetCrossFilter()`, `getCrossFilterSelections()`. Data requests made through `widgetApi.getData`
  already have page filters, widget filters and cross filters applied; pass `{ crossFilter: 'none' }`
  in options to bypass, or `'highlight'` to get both unfiltered and filtered results (`response.crossFilter`).

State persistence: `api.getState()` returns the JSON; save it (DB/localStorage) and restore with
`api.setState(state)` (+ `api.clearHistory()` so undo does not cross reports). `onStateUpdated`
fires on every change (`event.state`).

---

## 4. Custom widget: "Booking Readiness"

Verified API (`ag-studio-react`): `AgWidgetDefinition<TWidgetType, TIn, TOut, TOptions>` with
`comp: string | ComponentType<AgWidgetParams<TOut>> | (new () => AgTypeScriptComponent<...>)`; register
with `createWidgets<TRegistry>({ additionalTypes, menu?, overrides?, defaultType? })` and pass the
result to the `widgets` prop (or a `(defaults) => config` function). The widget `comp` is a plain React component; it
receives `AgWidgetParams<TOut>`:

```
widgetId, widgetType, format, dataMapping (Record<mappingKey, AgWidgetField[]>), sort,
config, widgetApi, api (AgStudioApi), context
```

Rules I verified by compiling:

1. The widget **state type** must include a literal `type` and use `AgWidgetFieldReference[]` for each
   data-mapping key (that is what `initialState` holds). The component receives the same keys already
   hydrated to `AgWidgetField[]` (with `.key`, `.name`, `.format`...).
2. Data comes from `params.widgetApi.getData({ fields }, options)`; flat rows are keyed by **`field.key`**
   (`row[field.key]`; confirmed in the bundle's own widgets). Unaggregated fields become group-by
   dimensions; fields with an `aggregation` become measures. Page/widget/cross filters are applied for you.
3. The widget re-renders when its mapping/filters change (params change) - re-fetch in an effect keyed by
   the field keys, and pass an `AbortSignal` (`options.signal`) to cancel stale queries.
4. `widgetApi.setDisplayState('loading' | 'noData' | 'incompleteDataMapping' | 'displayed')` shows Studio's overlays.
5. `form` builds the edit-mode side panel; `createDefaults({ dataMappingItems })` gives the standard
   Setup (widget type, field slots, cross-filter) + Format (titles) tabs. `dataMapping` entries
   declare slots: `{ type: 'field' | 'fieldset', supportedRoles: ('category'|'temporal'|'numeric')[], required?, sort?, aiDescription? }`.
6. `defaultSize` / `minSize` are in canvas tracks (24 columns wide) `{width, height}`.
7. If AI should be able to create/configure the widget, give it `formatShape` (AI "requires" the shape per the type comment) and `ai: { label, description, usage, configuration }`. **UNVERIFIED at runtime.**

Because the metrics we want (required accepted / required invited, payers authorized vs min payers, time to
deadline) are *per outing row*, make the widget group by outing and map **un-aggregated numeric
fields as measures with `sum`** (one row per outing sums to itself). Deadline is a `temporal` field
mapped with `aggregation: 'min'` (or `'first'`).

```tsx
'use client';
import { useEffect, useState } from 'react';
import type {
  AgDefaultWidgetDefinition, AgReportState, AgWidgetData, AgWidgetDataFormat,
  AgWidgetFieldReference, AgWidgetParams,
} from 'ag-studio';
import { AgStudio, createWidgets, type AgRegistry, type AgWidgetDefinition } from 'ag-studio-react';

// State (what lives in AgReportState) — note the literal `type`.
interface ReadinessWidget extends AgWidgetData<
  {
    outing: AgWidgetFieldReference[];      // category: outings.title
    reqAccepted: AgWidgetFieldReference[]; // sum(outings.requiredAccepted)
    reqInvited: AgWidgetFieldReference[];  // sum(outings.requiredInvited)
    payers: AgWidgetFieldReference[];      // sum(outings.payersAuthorized)
    minPayers: AgWidgetFieldReference[];   // sum(outings.minPayers)
    deadline: AgWidgetFieldReference[];    // min(outings.deadline)
  },
  AgWidgetDataFormat<{ warnHours?: number }>
> { type: 'booking-readiness' }

function BookingReadiness(p: AgWidgetParams<ReadinessWidget>) {
  const { outing, reqAccepted, reqInvited, payers, minPayers, deadline } = p.dataMapping;
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const fields = [outing, reqAccepted, reqInvited, payers, minPayers, deadline].flatMap((f) => f ?? []);
  const sig = fields.map((f) => f.key).join('|');

  useEffect(() => {
    if (fields.length < 6) { p.widgetApi.setDisplayState('incompleteDataMapping'); return; }
    const ac = new AbortController();
    p.widgetApi.setDisplayState('loading');
    p.widgetApi
      .getData({ fields }, { signal: ac.signal })
      .then((r) => { setRows(r.results.rows); p.widgetApi.setDisplayState('displayed'); })
      .catch(() => { /* aborted or query error: onErrorRaised also fires */ });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, p.widgetApi]);

  const num = (f?: { key: string }, r?: Record<string, unknown>) => Number(f && r ? r[f.key] : 0);
  return (
    <ul className="space-y-3 p-2">
      {rows.map((r, i) => {
        const accepted = num(reqAccepted[0], r), invited = num(reqInvited[0], r);
        const auth = num(payers[0], r), min = num(minPayers[0], r);
        const hoursLeft = (new Date(String(r[deadline[0].key])).getTime() - Date.now()) / 36e5;
        const ready = accepted >= invited && auth >= min;
        return (
          <li key={i} className="flex items-center justify-between">
            <span>{String(r[outing[0].key])}</span>
            <span>{accepted}/{invited} accepted · {auth}/{min} payers · {Math.max(0, Math.round(hoursLeft))}h left</span>
            <b>{ready ? 'Ready' : 'Not ready'}</b>
          </li>
        );
      })}
    </ul>
  );
}

const readinessDef = {
  id: 'booking-readiness',
  label: 'Booking readiness',
  comp: BookingReadiness,
  dataMapping: {
    outing: { type: 'field', supportedRoles: ['category'], required: true },
    reqAccepted: { type: 'field', supportedRoles: ['numeric'], required: true },
    reqInvited: { type: 'field', supportedRoles: ['numeric'], required: true },
    payers: { type: 'field', supportedRoles: ['numeric'], required: true },
    minPayers: { type: 'field', supportedRoles: ['numeric'], required: true },
    deadline: { type: 'field', supportedRoles: ['temporal'], required: true },
  },
  form: ({ createDefaults }) =>
    createDefaults({
      dataMappingItems: [
        { key: 'outing', label: 'Outing' }, { key: 'reqAccepted', label: 'Required accepted' },
        { key: 'reqInvited', label: 'Required invited' }, { key: 'payers', label: 'Payers authorized' },
        { key: 'minPayers', label: 'Min payers' }, { key: 'deadline', label: 'Deadline' },
      ],
    }),
  defaultSize: { width: 12, height: 14 },
  minSize: { width: 6, height: 8 },
} satisfies AgWidgetDefinition<'booking-readiness', ReadinessWidget>;

// Registry type so initialState / widgets are typed with the custom widget included.
interface OutingsRegistry extends AgRegistry {
  widgets: readonly [...AgDefaultWidgetDefinition[], typeof readinessDef];
}

export const widgets = createWidgets<OutingsRegistry>({
  additionalTypes: [readinessDef],
  menu: [{ label: 'Outings', widgetIds: ['booking-readiness'] }], // shows in the edit-mode widget menu
});

export const readinessPage: AgReportState<OutingsRegistry> = {
  selectedPageId: 'ready',
  pages: [{
    id: 'ready',
    widgets: {
      readiness: {
        type: 'booking-readiness',
        dataMapping: {
          outing: [{ id: 'outings.title' }],
          reqAccepted: [{ id: 'outings.requiredAccepted', aggregation: 'sum' }],
          reqInvited: [{ id: 'outings.requiredInvited', aggregation: 'sum' }],
          payers: [{ id: 'outings.payersAuthorized', aggregation: 'sum' }],
          minPayers: [{ id: 'outings.minPayers', aggregation: 'sum' }],
          deadline: [{ id: 'outings.deadline', aggregation: 'min' }],
        },
      },
    },
    widgetLayout: { readiness: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 14 } },
  }],
};

// <AgStudio<OutingsRegistry> widgets={widgets} initialState={readinessPage} data={...} />
```

Notes:

- `satisfies AgWidgetDefinition<...>` plus the registry interface is what makes `initialState`
  accept `type: 'booking-readiness'`. Using the default registry instead gives a TS error that the
  type is not assignable (I hit exactly this). Pass `<AgStudio<OutingsRegistry> .../>` as the generic.
- Sharing component code by name: `comp` may be a string and the component placed in the `components`
  prop (`components={{ myKey: Component }}`); direct component references are simpler.
- If you only want deadline relative time to tick, keep a `setInterval` in the widget; Studio will not re-render it for you.
- The widget can also call `p.api` (the full `AgStudioApi`) and `p.widgetApi.toggleCrossFilter({type:'value', group:0, field: outing[0], value})` so that clicking a row cross-filters the other widgets (e.g. the participant grid).
- **Drill-down option (recommended for our app):** instead of a second Studio grid, react to cross filters
  (`widgetApi.getCrossFilterSelections()`) or use `onStateUpdated` to read the selected outing id and show a separate AG Grid
  Community participant table beside Studio (section 8).

Grid widgets with custom cell renderers (verified): `createWidgets` default `grid` can be overridden;
the React package exports `GridWidget`, `PivotGridWidget` and `AgGridWidgetOptions.createCellRenderer(field) => ComponentType<CustomCellRendererProps> | undefined`
(e.g. render a status pill for the "Readiness" column). Wiring is through `overrides`/`options` on the
`grid` definition (**UNVERIFIED example**; types are in `ag-studio-react/dist/types/src/interfaces.d.ts`).

---

## 5. Licence key

Facts from `ag-studio` source (`studio/license/*`, bundle lines ~58300-58720) and the reference repo:

- Where: `<AgStudioProvider licenseKey={...}>` (read at creation, applied globally) or
  `AgStudioLicenseManager.setLicenseKey(key)` before creating Studio. The reference repo takes
  `process.env.AG_STUDIO` in a Server Component and passes it as a prop. Licence keys are not secret
  in the browser sense (they ship to the client), but do not commit a real one; keep it in `.env.local`
  and pass it down as a prop like the reference (do **not** name it `NEXT_PUBLIC_*` unless you accept inlining at build time; either works).
- Licence types encoded in the key: `STUDIO-CORE`, `STUDIO-PRO`, `STUDIO-PRO-AI`. The module registry
  assigns the required type: base Studio is CORE; **the AI module (`AgStudioAiModule`) requires `PRO-AI`**
  (`license: "PRO-AI"` in the bundle). A key covering a lower tier than a registered module produces an
  "Incompatible License Key" error + watermark.
- **No key:** Studio still runs with **all features unlocked** ("All AG Studio features are unlocked for trial").
  It logs a boxed `console.error` ("License Key Not Found ... email info@ag-grid.com for a trial license key")
  and shows a watermark overlay element (`.ag-studio-watermark`) with the text **"For Trial Use Only"**
  (it fades after ~5 s: the element gets an opacity-zero class immediately and is hidden after 5 000 ms).
  `isDisplayWatermark` is false on `localhost` unless the force-watermark flag is set, so you
  mainly see it on deployed (non-localhost) hosts. The console error is emitted regardless.
- Invalid / expired / trial-expired key: console errors + watermark text ("Invalid License", "License Expired",
  "Trial Period Expired"). No feature is disabled by the code I read; the licence is
  enforcement-by-watermark. (Whether the docs state different contractual limits: **UNVERIFIED, docs unreachable**.)
- Free trial: the README links a **45-day enterprise trial** (https://www.ag-grid.com/studio/license-pricing/?tab=trial) with no restrictions or watermark. Licence is commercial; do not redistribute the key in the repo.
- **An AG Grid Enterprise key is NOT needed for Studio.** `ag-grid-enterprise` is a hard dependency
  of `ag-studio`, but its `GridLicenseManager` short-circuits when the grid is created by Studio
  (`if (beans.studio) { isDisplayWatermark: () => false }`), so grid widgets inside Studio never show the grid
  watermark. Likewise charts are bundled. Only the single Studio key matters.
- A *separate* plain `AgGridReact` on another page using only Community modules needs no key and shows no watermark.
  Never register `AllEnterpriseModule` in our own grids unless we also hold an AG Grid Enterprise key.
- For the hackathon: the sponsor boilerplate documents `AG_STUDIO` in `.env.local` as optional, so
  a demo without a key works but logs the console error and (off-localhost) shows the trial watermark. Ask the sponsors for the hackathon key.

---

## 6. Theming (cream / navy / coral)

`studioTheme` (exported from `ag-studio`) is a Theme object; `.withParams(...)` returns a new theme
(`AgStudioTheme<AgStudioThemeParams>`, params = shared + core + grid + chart params). Also exported:
`createStudioTheme()`, `studioGridTheme`, `iconSetStudio`, `studioIconOverrides`, `THEME_DEFAULTS`.
Pass it to `<AgStudio theme={...}>`. Parameter values can be CSS variables (`'var(--navy)'`), which
is how the reference follows its design tokens - so the theme tracks `globals.css` automatically.

```ts
import { studioTheme } from 'ag-studio';

const PALETTE = ['#14213D', '#E8664F', '#2A9D8F', '#E9B44C', '#6C7A89', '#9B5DE5', '#F28482', '#84A59D', '#3D5A80', '#B56576'];

export const outingsTheme = studioTheme.withParams({
  // shared by Studio chrome, grids, charts
  fontFamily: 'var(--font-inter), system-ui, sans-serif',
  fontSize: 14,
  textColor: '#14213D',
  foregroundColor: '#14213D',
  subtleTextColor: '#6B6F80',
  backgroundColor: '#FFFDF7',
  borderColor: '#E7DFCF',
  accentColor: '#E8664F',
  // canvas and widget cards
  studioWrapperBackgroundColor: '#FBF6EA',
  studioCanvasBackgroundColor: '#FBF6EA',
  studioCanvasPadding: 20,
  studioCanvasRowHeight: 18,
  studioWidgetBackgroundColor: '#FFFFFF',
  studioWidgetBorder: { width: 1, color: '#E7DFCF' },
  studioWidgetBorderRadius: 14,
  studioWidgetTitleFontSize: 16,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: '#14213D',
  // grid widgets
  gridHeaderBackgroundColor: '#FFFDF7',
  gridHeaderTextColor: '#6B6F80',
  gridRowHeight: 40,
  gridRowHoverColor: '#FFF1E8',
  // charts: 10 fills/strokes
  ...Object.fromEntries(PALETTE.flatMap((c, i) => [[`chartPaletteFills${i + 1}Color`, c], [`chartPaletteStrokes${i + 1}Color`, c]])),
});
```

(The first part of this block, as a literal object, type-checked; the spread of `Object.fromEntries`
is untyped, so if `tsc` rejects it, write the keys out literally like the checked version.)

Notes:

- Parameters in `THEME_DEFAULTS` show what is editable: `fontFamily`, `fontSize`, `borderColor`,
  `backgroundColor`, `textColor`, `studioCanvas*`, `studioPanel*`, `studioWidget*` (background, padding, border,
  radius, title/subtitle/caption fonts), `grid*` (row height, row/column/header borders), `chart*`
  (fonts, axis/grid line colours, `chartPaletteFills{1..10}Color`).
- Per-widget overrides (`format.widget` appearance, typography) are part of widget state.
- Fonts: Google Fonts can be auto-loaded with `loadThemeGoogleFonts`; we already ship `@fontsource-variable/*`, so use the font-family CSS variable.
- CSS layering: `themeCssLayer` + `themeStyleContainer={document.body}` if Tailwind layers fight Studio's injected CSS (**UNVERIFIED**; try only if styles clash).
- Dark mode: the README says light and dark are supported; a dark theme is a different `withParams` set (**UNVERIFIED** helper API).

---

## 7. AI agent framework (adapter for our Anthropic-backed route)

Needs: the `Ai` module and a `PRO-AI` licence.

```tsx
import { AgStudioAiModule, createAiHarness } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';

<AgStudioProvider licenseKey={key} modules={[AgStudioAiModule]}>
  <AgStudio ai={aiSetup} ... />            {/* aiSetup is read once at creation: useMemo it / keep it stable */}
</AgStudioProvider>
```

`ai` is `AgAiHarnessSetup = AgAiHarness | ((params: { api, context }) => AgAiHarness)`. The normal path:
`createAiHarness(api, defaultsOrBuilder)` where defaults = `AgAiHarnessDefaults`
`{ adapter, primary?: 'lead'|'data'|'page'|'planning'|'widget', models?, history?, promptStarters?, observers? }`.
Without the `Ai` module the panel is absent. The sponsor repo hides the assistant entirely when no server key is configured by simply not passing `ai`.

### 7.1 The adapter interface (`AgLlmAdapter`) - verified

```ts
interface AgLlmAdapter {
  executeTurn(request: AgLlmRequest, options?: { signal?: AbortSignal; trace?: AgAiTraceContext }): AgLlmResponseHandler;
}
interface AgLlmRequest {
  input: AgAiConversationItem[];     // whole conversation so far (Studio owns history; you are stateless)
  instructions?: string;             // system prompt for this turn (rebuilt each turn from live dashboard state)
  tools?: AgAiToolSchema[];          // { name, description, parameters: JSON Schema, kind?, provider? }
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseFormat: { type: 'text' } | { type: 'json'; name; description?; schema };   // Studio's loop uses text
  model?: { id: string; effort?: string };   // present only when you configured `models`
}
interface AgLlmResponseHandler {
  stream: AsyncIterable<AgAiEvent>;  // UI events (text/reasoning/tool-call deltas)
  complete: Promise<AgLlmResponse>;  // the authoritative final result
}
interface AgLlmResponse {
  id: string; createdAt: number;     // ms epoch
  status: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete';
  output: AgAiOutputItem[];          // AgAiOutputMessage | AgAiReasoningItem | AgAiToolCall
  error?: { code: string; message: string };
  incompleteDetails?: { reason?: 'max_output_tokens' | 'content_filter' };
  usage?: { inputTokens; outputTokens; totalTokens?; reasoningTokens?; cachedInputTokens?; cacheWriteTokens? };
  model?: string;
}
```

Behaviour of Studio's loop (read from the bundle, `directLlmRunner`): per turn it calls
`executeTurn`, does `yield* handler.stream` (**drains the stream first**), then `await handler.complete`.
It throws unless `status` is `'completed'` or `'incomplete'`. **Tool calls are taken from
`response.output` (items with `type: 'function_call'`), not from stream events** - the stream is for the live chat UI.
Studio then executes every `client` tool in the browser, appends the results to history and calls `executeTurn` again, until a turn has no tool calls (default cap `maxTurns` 100; settable per agent).
So your adapter must make `complete` resolve with the full output, and make the stream end.

Conversation items you receive in `request.input` (`AgAiConversationItem`):

| item | shape | map to Anthropic |
| --- | --- | --- |
| user/system input | `{kind:'input', type:'message', role:'user'\|'system', content:[{type:'text',text}\|image\|file], status}` | `user` message text blocks (system -> fold into `system`) |
| assistant text | `{kind:'output', type:'message', role:'assistant', content:[{type:'text',text,annotations} \| {type:'refusal',refusal}], status}` | `assistant` text block |
| tool call | `{kind:'output', type:'function_call', callId, name, arguments: string(JSON), status}` | `assistant` `tool_use` block `{id: callId, name, input: JSON.parse(arguments)}` |
| tool result | `{type:'function_call_output', callId, output: string, status}` | `user` `tool_result` block `{tool_use_id: callId, content: output}` |
| reasoning | `{kind:'output', type:'reasoning', summary, content?}` | drop (Anthropic thinking blocks need signatures; do not replay) |

Anthropic requirements to respect when mapping: alternate roles (merge consecutive same-role items);
every `tool_use` must be answered by a `tool_result` in the **next** user message; keep the order. Output mapping:
`text` blocks -> `AgAiOutputMessage` (`content:[{type:'text', text, annotations: []}]`, `status:'completed'`),
`tool_use` -> `AgAiToolCall` (`callId = block.id`, `arguments = JSON.stringify(block.input)`),
`stop_reason: 'max_tokens'` -> `status:'incomplete', incompleteDetails:{reason:'max_output_tokens'}`,
usage `input_tokens/output_tokens` -> `usage`. Tool schemas: map `{name, description, parameters}` to
`{name, description, input_schema: parameters}`. `AgJSONSchema` is JSON Schema 2020-12 and uses the sentinel
`{ not: {} }` inside `anyOf` for "undefined" (the OpenAI example strips it); sanitise that and any
`$ref`/`$defs` quirks before sending to Anthropic (**UNVERIFIED** against live API; Anthropic accepts most JSON Schema, but test each of the 16 tool schemas once).
Tool args may contain `null` for optional values when a provider is run in "strict" mode; Studio's shapes reject
`null` for optional fields in the OpenAI path (the example strips nulls). Do the same defensively.

### 7.2 Stream events (`AgAiEvent`, discriminated on `type`) - verified

The adapter's stream should emit **content events only** (no `RUN_*`/`STEP_*`; the loop adds them):

```
TEXT_MESSAGE_START   {messageId, role:'assistant'}
TEXT_MESSAGE_CONTENT {messageId, delta}
TEXT_MESSAGE_END     {messageId}
TEXT_MESSAGE_CHUNK   {messageId?, delta?}          // single-event alternative
TOOL_CALL_START      {toolCallId, toolCallName}
TOOL_CALL_ARGS       {toolCallId, delta}           // partial JSON string fragments
TOOL_CALL_END        {toolCallId}
TOOL_CALL_CHUNK      {toolCallId?, toolCallName?, delta?}
REASONING_MESSAGE_START/CONTENT/END/CHUNK          // optional "thinking" display
```

(plus protocol-level `RUN_*`, `STEP_*`, `STATE_*`, `RAW`, `CUSTOM` that you do not emit.)
Anthropic Messages streaming maps 1:1: `content_block_start(type:text)` -> TEXT_MESSAGE_START,
`text_delta` -> TEXT_MESSAGE_CONTENT, `content_block_stop` -> TEXT_MESSAGE_END;
`content_block_start(type:tool_use)` -> TOOL_CALL_START(toolCallId = block.id, name), `input_json_delta` ->
TOOL_CALL_ARGS, stop -> TOOL_CALL_END; `message_delta/stop_reason` -> final response.
Streaming is expected but only the UI depends on it; a non-streaming adapter could yield nothing and resolve `complete`, at the cost of no live text.

### 7.3 Recommended split for our stack

Keep Anthropic and its key on the server. Two clean options:

A. **Thin client adapter + translating route (recommended).** Route `POST /api/ai/turn` receives the
   `AgLlmRequest` JSON, validates/limits it (model allow-list, max tokens, auth), converts to an Anthropic
   `messages.stream` call, and writes **NDJSON lines** `{kind:'event', event: AgAiEvent}` as it streams, ending with
   `{kind:'done', response: AgLlmResponse}`. The client adapter below only parses lines. All Anthropic mapping lives in
   one server file we can unit test with vitest.
B. Browser maps raw Anthropic SSE itself (what the sponsor repo does for OpenAI: the browser translates a
   proxied provider SSE stream). More client code and bundle; no benefit.

Client adapter (type-checked; the NDJSON protocol is ours, not AG's):

```ts
import type { AgAiEvent, AgLlmAdapter, AgLlmRequest, AgLlmResponse, AgLlmResponseHandler } from 'ag-studio';

type Line = { kind: 'event'; event: AgAiEvent } | { kind: 'done'; response: AgLlmResponse };

async function* lines(req: AgLlmRequest, signal: AbortSignal | undefined, out: { response?: AgLlmResponse }) {
  const res = await fetch('/api/ai/turn', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal,
  });
  if (!res.ok || !res.body) throw new Error(`AI route failed (${res.status})`);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n'); buf = parts.pop() ?? '';
    for (const p of parts) {
      if (!p.trim()) continue;
      const m = JSON.parse(p) as Line;
      if (m.kind === 'event') yield m.event as AgAiEvent; else out.response = m.response;
    }
  }
}

export const outingsAdapter: AgLlmAdapter = {
  executeTurn(request, options): AgLlmResponseHandler {
    const out: { response?: AgLlmResponse } = {};
    let ok!: (r: AgLlmResponse) => void, fail!: (e: unknown) => void;
    const complete = new Promise<AgLlmResponse>((a, b) => { ok = a; fail = b; });
    async function* stream() {
      try {
        yield* lines(request, options?.signal, out);
        if (out.response) ok(out.response); else fail(new Error('AI route ended without a response'));
      } catch (e) { fail(e); throw e; }
    }
    return { stream: stream(), complete };
  },
};
```

Wire it (type-checked; defaults variant):

```ts
import { createAiHarness, type AgAiHarnessSetup } from 'ag-studio';

export const aiSetup: AgAiHarnessSetup = ({ api }) =>
  createAiHarness(api, {
    adapter: outingsAdapter,
    primary: 'lead',
    models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet' }],   // omit = no picker; forwarded as request.model.id
    promptStarters: [
      { label: 'Who is not ready?', prompt: 'Which outings are not ready to book and why?' },
      { label: 'Deadlines', prompt: 'Add a chart of hours to booking deadline by outing.' },
    ],
  });
```

Server side: pick the model from the allow-list (never trust `request.model.id` blindly), set `max_tokens`,
require an authenticated merchant session, rate-limit, and forward `req.signal` to cancel the upstream stream when the user stops the chat.

### 7.4 What Studio exposes to the agent (tools) - verified from the bundle

Five built-in agents (`createAiHarness` builder gets them as `builtIn.{lead,data,page,planning,widget}`; `tools` helper gives plan/delegate tools). All Studio tools are **`client` tools: executed in the browser** against `AgStudioApi`; the server never runs them.

| Agent | Tools it holds |
| --- | --- |
| `lead` (default primary) | `view_schema`, `view_report`, `view_page`, `view_plan`, `update_plan`, `clear_plan`, `rename_thread`, `delegate_to(data,widget,page,planning)` |
| `data` | `execute_query`, `view_schema`, `create_expression`, `update_expression`, `delete_expression` |
| `planning` | `view_schema`, `view_report`, `view_page`, `view_plan`, `create_plan` |
| `page` | `view_schema`, `view_page`, `view_plan`, `add_page_filter`, `remove_page_filter`, `add_widget`, `position_widget`, `remove_widget` |
| `widget` | `view_plan`, `view_widget`, `view_schema`, `add_widget_filter`, `remove_widget_filter`, `configure_widget` |

Also `complete_task` (sub-agent hand-back). Full set on `AgAiStudioTools`: `viewSchema viewReport viewPage viewWidget
executeQuery createExpression updateExpression deleteExpression addWidget positionWidget removeWidget addPageFilter
removePageFilter addWidgetFilter removeWidgetFilter configureWidget`.

So the agent can: read schema/report/page/widget config; run aggregation or projection queries
(joins, filters, sort, pagination) over the loaded data via `execute_query`; add/move/resize/remove widgets;
reconfigure widgets (data mapping + format); add/remove page and widget filters (this is how "filter" requests
work: they change the *dashboard's filters*, i.e. what viewers see); create/modify/delete calculated expressions.

Custom tools: `api.defineAiTool({ name, description, params: s => ..., execute })` (kinds `client`, `server` = advertised only,
`provided` = provider-hosted). Use `kind:'server'`/your own route only for things Studio cannot do.

### 7.5 Safety notes (things that would let the agent do unsafe things)

1. **Data exfiltration to the LLM.** `execute_query` results (rows) and `view_*` outputs are sent to the model as tool results through our route. The model can read every field of every loaded table, including participant names/emails if they are in a source. Keep PII out of the `data` sources (use initials / ids / counts); this is the main control.
2. **Mutating tools.** `remove_widget`, `configure_widget`, `delete_expression`, filter tools, etc. edit the live report without confirmation. Changes are undoable (`api.undo()`) and flow through `onStateUpdated`; they only change the viewer's local state until we call `getState()` and save. Do **not** auto-save agent edits; show an "unsaved changes" bar and require explicit save.
3. **Least privilege.** Restrict the roster: the harness builder lets you replace each built-in agent's `tools`. The helper below (type-checked) keeps only read/analysis tools; for a read-only "ask the dashboard" assistant also drop `delegate_to` targets that hold write tools (`page`, `widget`) by not registering those agents (`delegate_to` only lists agents that exist in the roster).
4. **Prompt injection.** Field values (outing titles, notes) reach the model inside tool results. Treat them as untrusted; do not add tools that can act outside the dashboard (no email/payment/booking actions), and never expose payment or admin routes as AI tools.
5. **Server route hardening.** Auth + per-merchant rate limit, cap `max_tokens`, cap `input` size, allow-list models, never echo the Anthropic key, and do not log full prompts containing data.
6. `executeQuery` has engine limits (`dataOptions`, widget `dataLimits.maxGroup`, request `maxRows/maxBytes`); set `dataOptions` to bound exports/rows.

```ts
import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiTool, type AgAnyAiAgentDefinition } from 'ag-studio';

const ALLOWED = new Set([
  'view_schema', 'view_report', 'view_page', 'view_widget', 'execute_query',
  'delegate_to', 'complete_task', 'rename_thread', 'view_plan', 'create_plan', 'update_plan', 'clear_plan',
]);
const readOnly = (d: AgAnyAiAgentDefinition): AgAnyAiAgentDefinition => ({
  ...d,
  tools: (ctx, params) => (d.tools?.(ctx, params) ?? []).filter((t: AgAiTool) => ALLOWED.has(t.name)),
});

export const readOnlyAi: AgAiHarnessSetup = ({ api }) =>
  createAiHarness(api, ({ builtIn }) => ({
    primary: 'lead',
    agents: (['lead', 'data', 'planning'] as const).map((id) =>
      directLlmRunner({ ...readOnly(builtIn[id]), adapter: outingsAdapter })),
  }));
```

Also exposed: `aiText` (override tool descriptions/prompts, keys like `'tools.view_schema.description'`),
`aiToolDisplay` (how tool calls render in the chat), `observers` (telemetry: usage, cost), `history`
(persistence store for threads; default in-memory). `clientToolRunner` is the alternative loop when the
**server** runs the Anthropic loop and only Studio's tools execute in the browser.

---

## 8. AG Grid Community v36 (fallback grid and drill-down participant grid)

Verified exports: `ModuleRegistry`, `AllCommunityModule`, `themeQuartz`, `colorSchemeLight`,
`iconSetQuartz`, `enableDevValidations` from `ag-grid-community`; `AgGridReact`, `AgGridProvider`
from `ag-grid-react` (React peer `^16.8 .. ^19`).

```tsx
'use client';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';

ModuleRegistry.registerModules([AllCommunityModule]);   // once, module scope (idempotent)

const gridTheme = themeQuartz.withParams({
  accentColor: '#E8664F',
  backgroundColor: '#FFFDF7',
  foregroundColor: '#14213D',
  fontFamily: 'inherit',
});

type Participant = { name: string; status: string; authorized: boolean };
const cols: ColDef<Participant>[] = [
  { field: 'name', headerName: 'Participant' },
  { field: 'status' },
  { field: 'authorized', headerName: 'Payment authorized' },
];

export function ParticipantGrid({ rows }: { rows: Participant[] }) {
  return (
    <div style={{ height: 400 }}>{/* the grid needs a height */}
      <AgGridReact<Participant>
        theme={gridTheme}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.name}
      />
    </div>
  );
}
```

Facts and alternatives:

- **Themes API (v33+ style):** pass `theme={themeQuartz.withParams({...})}`; **do not import** `ag-grid-community/styles/*.css`
  (legacy CSS themes are a different mode and would conflict). `withParams` takes the standard theme params
  (`accentColor`, `backgroundColor`, `foregroundColor`, `borderColor`, `fontFamily`, `headerFontWeight`, `headerTextColor`, `rowHoverColor`, ...).
- **Smaller bundle:** instead of `AllCommunityModule`, register just what you use
  (`ClientSideRowModelModule`, `TextFilterModule`, `NumberFilterModule`, `DateFilterModule`, `QuickFilterModule`,
  `ColumnAutoSizeModule`, ...) and scope them with `<AgGridProvider modules={[...]}>`, as the sponsor repo does.
  `AgGridProvider` also takes `licenseKey` (only for Enterprise modules; we use none).
- `AgGridProvider` and `ModuleRegistry.registerModules` are alternatives; both work with React 19.
- Row data: prefer `getRowId` for stable updates; update `rowData` immutably or use `api.applyTransaction`.
- Drill-down flow: Studio widget/cross-filter -> host reads selected outing id (via `onStateUpdated` -> `event.state.pages[i].crossFilter`,
  or a button in the custom widget calling a host callback passed through the `context` prop (`context?: any` on `AgStudio`, available in widgets as `params.context`)) -> fetch participants for that outing from our API -> `ParticipantGrid`.
  Participant PII then never needs to be in the Studio data sources.
- Enterprise features (grouping, pivot, row grouping, Excel export, side bar, set filter) are **not** available from
  Community; do not import `ag-grid-enterprise` in our own grids (it works without a key but shows a watermark + console error).
- Fallback if Studio fails to load (licence/network): a Community `AgGridReact` over the same `OutingRow[]` with the same column defs. Render it from the error boundary (`error.tsx`) or when `onErrorRaised` fires.

---

## 9. Pitfalls checklist

- **Client-only.** Never import `ag-studio*` in a Server Component. No `'use client'` in the packages. Use a client wrapper with `next/dynamic({ ssr: false })` (Next 16: not allowed in Server Components).
- **Container height.** Zero-height parent = invisible dashboard. Give an explicit height (`calc(100dvh - header)`), `min-height: 600px` is Studio's own minimum.
- **Bundle size.** Studio ESM is 3.8 MB raw / 1.8 MB minified, plus bundled AG Grid Enterprise and AG Charts Enterprise. Only load it on the dashboard route, keep it out of the layout. First paint of that route will be heavy; show a skeleton.
- **No CSS imports.** Studio injects its own styles; adding AG Grid legacy CSS files can clash. With Tailwind v4 (`@tailwindcss/turbopack` here) consider `themeCssLayer` if resets override Studio styles (**UNVERIFIED**).
- **`initialState` and `ai` are read once.** Changing them later is ignored; use `api.setState` and remount for a different `ai`.
- **Stable `data` identity.** `useMemo` the data definition; async/structural data changes (new sources/fields) are ignored after init - remount via `key` to restructure.
- **Strict Mode (React 19 dev double-mount).** I did not run a browser; the sponsor app runs on Next's defaults and its `AgStudio` is created in `componentDidMount`/destroyed on unmount so a mount/unmount/mount cycle is expected to be handled. **UNVERIFIED**; if you see two instances or a "licence set more than once" message, check that you do not call `AgStudioLicenseManager.setLicenseKey` in addition to the provider, and keep the key constant.
- **React 19.** `ag-studio-react` peers allow 19 and its own devDeps are 18.3; compiled fine here against `@types/react` 19. Custom widget components receive props; avoid legacy `defaultProps`/`findDOMNode`.
- **Licence console noise.** Without a key you get a boxed console.error each load; with the AI module and a non-`PRO-AI` key you get "Incompatible License Key". Keep the key out of git.
- **Dates.** Send ISO strings; keep fields typed `dateFormat`/`dateTimeFormat`; computed "time to deadline" belongs in the custom widget (or a field `accessor`), not stored (it would go stale).
- **Money/currency.** No automatic currency conversion; filter by currency before summing (the sponsor repo adds this to its dataset description for the agent).
- **Relative-date filters in saved state** reportedly fail to apply on load (sponsor repo comment); build them via the filter widget at runtime instead of `initialState`.
- **Unaggregated vs aggregated fields** in widget mappings: an un-aggregated field is a *group-by*; a field with `aggregation` is a measure. Mixing them wrongly gives unexpected row counts.
- **Data leaves the server.** All source rows are in the browser; the AI path additionally forwards query results to the LLM. Scope rows to the logged-in merchant on the server before building `data`.
- **Docs unreachable here.** Re-check three things against https://www.ag-grid.com/studio/react/ when network allows: custom widget docs (`custom-widgets`), AI docs (`ai-agents`), and licensing (`/studio/licensing/`). The AI adapter details here come from the types and bundle, which are authoritative for 3.0.0.

## 10. Unverified items (summary)

1. Runtime behaviour in a browser (no browser run): Strict Mode double mount, watermark appearance, CSS layer interplay.
2. Anthropic acceptance of Studio's JSON-Schema tool definitions (need a one-time sanitiser test of all 16 tool schemas).
3. `ai`/`formatShape` requirements for AI-created custom widgets.
4. Overriding the built-in `grid` widget with a React cell renderer (`createCellRenderer`) - types exist, example not compiled.
5. Dark-mode theme helper and `themeCssLayer` usage.
6. Official-docs statements on licence feature limits (the code only enforces via watermark/console).
7. Exact semantics of `api.reload()` and of structural `data` updates after init.
