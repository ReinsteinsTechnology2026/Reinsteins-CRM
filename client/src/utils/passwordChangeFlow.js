// Client-side helpers for the mandatory first-login password change.
//
// The challenge token the server hands out after a correct temporary password lives under its OWN
// sessionStorage key. It is deliberately NOT "token": the API interceptor, ProtectedRoute and every
// guard read "token", so the challenge can never be mistaken for a session. sessionStorage means a
// refresh keeps the user on the page while closing the tab discards it.

export const PENDING_PASSWORD_CHANGE_KEY = "passwordChangePending";

const FALLBACK_POLICY = { minLength: 10, requireUppercase: true, requireLowercase: true, requireDigit: true };

export function storePendingPasswordChange({ challengeToken, companySlug, employeeId, fullName, company, passwordPolicy }) {
  sessionStorage.setItem(
    PENDING_PASSWORD_CHANGE_KEY,
    JSON.stringify({
      challengeToken,
      companySlug: companySlug || null,
      employeeId: employeeId || null,
      fullName: fullName || null,
      company: company || null,
      passwordPolicy: passwordPolicy || null,
    })
  );
}

// null when absent or unreadable (a damaged value is removed rather than trusted).
export function readPendingPasswordChange() {
  try {
    const raw = sessionStorage.getItem(PENDING_PASSWORD_CHANGE_KEY);
    if (!raw) return null;

    const value = JSON.parse(raw);
    if (!value || typeof value.challengeToken !== "string" || !value.challengeToken) {
      clearPendingPasswordChange();
      return null;
    }

    return value;
  } catch {
    clearPendingPasswordChange();
    return null;
  }
}

export function clearPendingPasswordChange() {
  try {
    sessionStorage.removeItem(PENDING_PASSWORD_CHANGE_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}

// The same rules the server enforces (it sends them with the login answer), as a checklist.
// The server remains the authority; this only gives the user live feedback.
export function evaluatePasswordRules(password, policy) {
  const rules = { ...FALLBACK_POLICY, ...(policy || {}) };
  const value = typeof password === "string" ? password : "";
  const list = [{ key: "length", label: `At least ${rules.minLength} characters`, met: value.length >= rules.minLength }];

  if (rules.requireUppercase) list.push({ key: "upper", label: "One uppercase letter", met: /[A-Z]/.test(value) });
  if (rules.requireLowercase) list.push({ key: "lower", label: "One lowercase letter", met: /[a-z]/.test(value) });
  if (rules.requireDigit) list.push({ key: "digit", label: "One number", met: /[0-9]/.test(value) });

  return list;
}
