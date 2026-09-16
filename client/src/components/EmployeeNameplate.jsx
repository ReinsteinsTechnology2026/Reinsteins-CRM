import "./EmployeeNameplate.css";

// ==========================================
// EMPLOYEE NAMEPLATE
//
// Shared "Name" + "Designation" stacked display used anywhere an
// employee is presented in a people/employee context (dashboard
// headers, the Shift Schedule employee column, the Admin Shift
// Management employee picker, etc.) -- purely presentational, takes
// its data from whatever payload the caller already has (login
// response, employee list row, profile) so no component using this
// ever needs its own extra API call just to show a title under a
// name. Falls back to name-only when there is no designation.
// ==========================================

function EmployeeNameplate({ name, designation, size = "md" }) {
  if (!name) {
    return null;
  }

  return (
    <span className={`employee-nameplate employee-nameplate-${size}`}>
      <span className="employee-nameplate-name">{name}</span>
      {designation ? (
        <span className="employee-nameplate-designation">{designation}</span>
      ) : null}
    </span>
  );
}

export default EmployeeNameplate;
