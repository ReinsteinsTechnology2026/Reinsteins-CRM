// ==========================================
// ZIOVAULT -- who administers the company vault (the browser's copy of the server's rule)
//
//     role = 'admin'   OR   system_access = 'super_admin'
//
// The server decides this from the user's fresh database row on every request (services/vaultAuthz.js); this copy only decides whether to
// OFFER "New collection" and the offboarding screen. Hiding or showing a button is never the control: a person for whom this is wrong
// simply gets a refusal from the server. A plain system_access of 'admin' does not qualify unless the role is also 'admin'.
// The CRM returns the field as `systemAccess`; the stored legacy session may still say `system_access`, so both spellings are read.
// ==========================================

export const canAdministerCompanyVault = (user) => {
  if (!user) return false;
  const access = user.systemAccess !== undefined ? user.systemAccess : user.system_access;
  return user.role === "admin" || access === "super_admin";
};
