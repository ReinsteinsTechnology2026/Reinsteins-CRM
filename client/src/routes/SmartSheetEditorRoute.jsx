import { lazy, Suspense } from "react";

// ==========================================
// LAZY ROUTE FOR THE SPREADSHEET EDITOR
//
// The editor imports Univer (a large spreadsheet engine). Loading it with React.lazy keeps it out of
// the CRM's initial bundle: the code is downloaded only when someone actually opens a spreadsheet.
// The list page (pages/SmartSheets/SmartSheetsList.jsx) is small and loads normally.
// ==========================================

const SmartSheetEditorPage = lazy(() => import("../pages/SmartSheets/SmartSheetEditorPage"));

function SmartSheetEditorRoute() {
  return (
    <Suspense fallback={<p style={{ padding: 24, color: "var(--text-secondary)" }}>Loading the spreadsheet editor…</p>}>
      <SmartSheetEditorPage />
    </Suspense>
  );
}

export default SmartSheetEditorRoute;
