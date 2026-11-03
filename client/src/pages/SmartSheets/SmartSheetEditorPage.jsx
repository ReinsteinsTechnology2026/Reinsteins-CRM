import { useLocation, useNavigate, useParams } from "react-router-dom";

import SmartSheetEditor from "../../components/SmartSheets/SmartSheetEditor";

// The route component for /<portal>/smart-sheets/:sheetId. Loaded lazily (routes/SmartSheetEditorRoute.jsx),
// because it pulls in the spreadsheet engine.
function SmartSheetEditorPage() {
  const { sheetId } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Back goes to the list of the SAME portal (keeps a /:companySlug prefix).
  const listPath = pathname.replace(/\/smart-sheets\/.*$/i, "/smart-sheets");

  return <SmartSheetEditor key={sheetId} sheetId={sheetId} backPath={listPath} onBack={() => navigate(listPath)} />;
}

export default SmartSheetEditorPage;
