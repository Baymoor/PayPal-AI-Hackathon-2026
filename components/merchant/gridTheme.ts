import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";

// Community modules only: no Enterprise features, so no AG Grid licence is needed here.
ModuleRegistry.registerModules([AllCommunityModule]);

export const outingsGridTheme = themeQuartz.withParams({
  accentColor: "#C8402D",
  backgroundColor: "#FFFFFF",
  foregroundColor: "#14213D",
  borderColor: "#EADFD3",
  headerBackgroundColor: "#FBF6F1",
  headerTextColor: "#14213D",
  headerFontWeight: 600,
  rowHoverColor: "#FDF1EC",
  oddRowBackgroundColor: "#FFFFFF",
  fontFamily: '"Inter Variable", system-ui, sans-serif',
  fontSize: 14,
  borderRadius: 12,
  wrapperBorderRadius: 16,
});
