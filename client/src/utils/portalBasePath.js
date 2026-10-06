// Returns the portal prefix for the current URL, preserving a company
// slug when present: "/admin", "/employee", "/acme/admin", "/acme/employee".
export function getPortalBasePath(pathname) {
    const match = pathname.match(/^(.*?\/)?(admin|employee)(\/|$)/);

    if (!match) return "/employee";

    return `${match[1] || "/"}${match[2]}`.replace(/\/{2,}/g, "/");
}
