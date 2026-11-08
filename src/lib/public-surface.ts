import { isMockJobId, isMockOutputId, parsePublicRouteId } from "@/lib/ids";

/**
 * The only app this site serves.
 * A new app stays off the public surface until its id is added here.
 * There is no header, query, or env flag that turns the others back on.
 */
export const PUBLIC_APP_IDS = ["reverse-3d"] as const;

const PUBLIC_PAGE = "/reverse-3d";

export function isPublicApp(id: string): boolean {
  return (PUBLIC_APP_IDS as readonly string[]).includes(id);
}

export type PublicDecision =
  | { action: "allow" }
  | { action: "redirect"; location: typeof PUBLIC_PAGE }
  | { action: "deny"; message: string };

function normalizePath(pathname: string): string {
  const bare = pathname.split("?")[0]?.split("#")[0] ?? "/";
  if (bare.length > 1 && bare.endsWith("/")) return bare.slice(0, -1);
  return bare || "/";
}

function oneSegment(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..");
}

function isPublicJobId(id: string): boolean {
  if (!oneSegment(id)) return false;
  if (isMockJobId(id)) return true;
  const routed = parsePublicRouteId(id);
  return Boolean(routed && isPublicApp(routed.app));
}

function isPublicOutputId(id: string): boolean {
  if (!oneSegment(id)) return false;
  if (isMockOutputId(id)) return true;
  const routed = parsePublicRouteId(id);
  return Boolean(routed && isPublicApp(routed.app));
}

/** Whether this request may reach a page or route handler. Default is deny. */
export function decidePublicRequest(method: string, pathname: string): PublicDecision {
  const path = normalizePath(pathname);
  const read = method === "GET" || method === "HEAD";

  if (path === "/") return { action: "redirect", location: PUBLIC_PAGE };

  if (path.startsWith("/_next/") || path === "/favicon.ico" || path === "/icon" || path === "/icon.svg") {
    return read ? { action: "allow" } : { action: "deny", message: "Not found." };
  }

  if (path === PUBLIC_PAGE) {
    return read ? { action: "allow" } : { action: "deny", message: "Not found." };
  }

  if (PUBLIC_APP_IDS.some((id) => path === `/api/run/${id}`)) {
    return method === "POST" ? { action: "allow" } : { action: "deny", message: "Unknown app." };
  }

  if (path.startsWith("/api/run/")) {
    return { action: "deny", message: "Unknown app." };
  }

  if (path.startsWith("/api/jobs/")) {
    const id = path.slice("/api/jobs/".length);
    if (read && isPublicJobId(id)) return { action: "allow" };
    return { action: "deny", message: "Job not found." };
  }

  if (path.startsWith("/api/outputs/")) {
    const id = path.slice("/api/outputs/".length);
    if (read && isPublicOutputId(id)) return { action: "allow" };
    return { action: "deny", message: "Output not found." };
  }

  if (path.startsWith("/api/")) return { action: "deny", message: "Not found." };
  return { action: "deny", message: "Not found." };
}
