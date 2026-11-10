import { studioTheme } from "ag-studio";

/** Studio falls back to Arial / Source Sans for grids, charts and widget titles unless each family is set. */
const INTER = '"Inter Variable", system-ui, sans-serif';

/** Cream / navy / coral tokens from docs/design/DESIGN_SYSTEM.md (literal values: Studio injects its own CSS). */
export const outingsStudioTheme = studioTheme.withParams({
  fontFamily: INTER,
  gridFontFamily: INTER,
  gridHeaderFontFamily: INTER,
  gridCellFontFamily: INTER,
  chartFontFamily: INTER,
  studioCanvasFontFamily: INTER,
  studioWidgetTitleFontFamily: INTER,
  studioWidgetSubtitleFontFamily: INTER,
  studioWidgetCaptionFontFamily: INTER,
  fontSize: 14,
  textColor: "#14213D",
  foregroundColor: "#14213D",
  subtleTextColor: "#5B6478",
  backgroundColor: "#FFFFFF",
  borderColor: "#EADFD3",
  accentColor: "#C8402D",
  studioWrapperBackgroundColor: "#FBF6F1",
  studioCanvasBackgroundColor: "#FBF6F1",
  studioCanvasPadding: 0,
  studioCanvasRowHeight: 20,
  studioWidgetBackgroundColor: "#FFFFFF",
  studioWidgetBorder: { width: 1, color: "#EADFD3" },
  studioWidgetBorderRadius: 16,
  studioWidgetTitleFontSize: 16,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: "#14213D",
  gridHeaderBackgroundColor: "#FBF6F1",
  gridHeaderTextColor: "#14213D",
  gridRowHeight: 40,
  gridRowHoverColor: "#FDF1EC",
  // Studio colours a series by its position, so 1 to 4 are the status tokens of app/theme.css in the order every
  // chart lists its series: captured (green), refunded (purple), authorized (blue), cancelled (slate).
  chartPaletteFills1Color: "#1E6B45",
  chartPaletteStrokes1Color: "#1E6B45",
  chartPaletteFills2Color: "#5B3FA0",
  chartPaletteStrokes2Color: "#5B3FA0",
  chartPaletteFills3Color: "#1F5FA8",
  chartPaletteStrokes3Color: "#1F5FA8",
  chartPaletteFills4Color: "#4A5568",
  chartPaletteStrokes4Color: "#4A5568",
  chartPaletteFills5Color: "#C8402D",
  chartPaletteStrokes5Color: "#C8402D",
  chartPaletteFills6Color: "#8A5300",
  chartPaletteStrokes6Color: "#8A5300",
});
