import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Sets a route-appropriate browser tab title for the signed-in areas, for example "Attendance · Admin · ZioVenture".
// Display only: it reads the current path and writes document.title. It never touches routing, auth or data.
// `area` is the portal's name ("Admin", "Employee", "Owner Portal") and `root` is the path segment that starts that area.

const DEFAULT_TITLE = "ZioVenture";

const toLabel = (segment) =>
  segment
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");

export default function useRouteTitle(area, root) {
  const { pathname } = useLocation();

  useEffect(() => {
    const parts = pathname.split("/").filter(Boolean);
    const rootIndex = parts.indexOf(root);
    const rest = rootIndex === -1 ? [] : parts.slice(rootIndex + 1).filter((part) => !/^\d+$/.test(part));
    const page = rest.length > 0 ? toLabel(rest[rest.length - 1]) : "Dashboard";
    document.title = `${page} · ${area} · ${DEFAULT_TITLE}`;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [pathname, area, root]);
}
