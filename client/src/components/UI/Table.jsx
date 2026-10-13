import "./Table.css";

// Shared Table (Batch 1) -- a thin themed wrapper only (horizontal-
// scroll container + th/td styling). Callers still own their own
// <thead>/<tbody>/row markup and data, so this imposes no data shape
// and changes no existing table's business logic.

function Table({ children, className = "" }) {

  return (

    <div className="ui-table-wrap">

      <table className={["ui-table", className].filter(Boolean).join(" ")}>
        {children}
      </table>

    </div>

  );

}

export default Table;
